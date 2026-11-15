import {
  createRepoTools,
  type RepoWorkspace,
} from '@code-review-agent/agent-tools';
import { emptyTokenUsage } from '@code-review-agent/llm';
import type {
  PriorFinding,
  PRMeta,
  ReviewResultPayload,
  ReviewThread,
  TokenUsage,
} from '@code-review-agent/shared-types';
import { type BaseLlm, LlmAgent } from '@google/adk';
import type { ThinkingLevel } from '@google/genai';

import {
  type AgentSessionOutcome,
  runAgentSession,
  thinkingConfig,
} from './agents/agent-session.js';
import {
  firstLine,
  threadLocation,
  threadStatus,
} from './pipeline/thread-format.js';
import {
  type AnchoredFinding,
  createSubmitReviewTool,
  type SubmitReviewState,
  type SubmitReviewToolBundle,
  type ValidatedReviewSubmission,
} from './tools/submit-review.tool.js';

export const DEFAULT_MAX_LLM_CALLS = 10;
export const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_INLINE_DIFF_CHARS = 80_000;

export interface ReviewAgentInput {
  prMeta: PRMeta;
  workspace: RepoWorkspace;
  priorFindings?: PriorFinding[];
  /** Files triage flagged as the riskiest; the reviewer looks at them first. */
  focusFiles?: string[];
  /** Inline review threads already on the PR, from any author. */
  existingThreads?: ReviewThread[];
}

export interface ReviewAgentOptions {
  /** The LLM that runs the review (the reviewer role's model). */
  model: BaseLlm;
  /**
   * Maximum LLM calls permitted for the review session. Defaults to 10.
   */
  maxLlmCalls?: number;
  /**
   * Timeout in milliseconds for the review session. Defaults to 300_000 (5 min).
   */
  timeoutMs?: number;
  /**
   * Maximum character length of the annotated diff to embed directly in the prompt.
   * If exceeded, the agent is given the list of changed files and uses `get_pr_diff`.
   * Defaults to 80_000.
   */
  maxInlineDiffChars?: number;
  /**
   * Reasoning effort per model call (Gemini 3+ `thinkingLevel`). Omitted
   * means the model's own default, which is HIGH on Gemini 4 Hydrogen.
   */
  thinkingLevel?: ThinkingLevel;
}

export interface ReviewAgentResult {
  reviewResult: ReviewResultPayload;
  publishedFindings: PriorFinding[];
  /** This run's new findings (the ones in `reviewResult.comments`). */
  findings: AnchoredFinding[];
  /** Token usage summed over every model call of this review. */
  usage: TokenUsage;
}

interface ResolvedReviewOptions {
  model: BaseLlm;
  maxLlmCalls: number;
  timeoutMs: number;
  maxInlineDiffChars: number;
  thinkingLevel?: ThinkingLevel;
}

const SYSTEM_ROLE_INSTRUCTION = `You are a Principal Software Engineer performing a high-signal code review on a Pull Request.

## Review Principles
1. **High-Signal Only**: Report only actionable bugs, security vulnerabilities, race conditions, data loss risks, broken API/type contracts, unhandled error paths, or clear violations of the repository's documented guidelines.
2. **Zero Nitpicks**: Do NOT report formatting, naming preferences, missing comments, or speculative stylistic suggestions.
3. **Verify Before Reporting**: When a change touches imports, callers, shared types, or cross-file contracts, use \`grep_code\`, \`read_file\`, or \`find_files\` to verify the surrounding codebase before claiming something is broken. Be surgical with tool calls—stay well within your call budget.
4. **Exact Diff Line Anchoring**:
   - Every line in the annotated PR diff has a prefix: \`L<num> | +...\` (added line), \`L<num> |  ...\` (context line), or \`DEL | -...\` (deleted line).
   - Every finding's \`line\` (and optional \`startLine\`) MUST be a 1-based NEW-side line number taken from an \`L<num> |\` prefix in that file's diff hunk.
   - NEVER anchor a finding to a \`DEL |\` line or a line number outside the diff hunks.
5. **Finish via \`submit_review\`**:
   - You MUST conclude your review by calling the \`submit_review\` tool with a concise markdown \`summary\` and your \`findings\` array (pass \`[]\` if the PR has no actionable defects).
   - If \`submit_review\` rejects a finding due to an invalid diff anchor, adjust the line number to a valid \`L<num>\` line in the diff and call \`submit_review\` again immediately.`;

function formatGuidelinesSection(workspace: RepoWorkspace): string {
  const guidelines = workspace.getRepoGuidelines();
  if (!guidelines) {
    return '';
  }
  return `\n\n## Repository Guidelines\nFollow these project-specific conventions when reviewing:\n\n${guidelines}`;
}

function formatPriorFindingsSection(priorFindings: PriorFinding[]): string {
  if (priorFindings.length === 0) {
    return '';
  }
  const items = priorFindings
    .map(
      (f) =>
        `- \`${f.path}\` (lines ${f.startLine}-${f.endLine}) [${f.severity.toUpperCase()}]: ${f.title}`,
    )
    .join('\n');
  return `\n\n### Already Published Findings (Do Not Repeat)\nThe following findings were already posted on earlier commits of this PR. Do NOT report them again:\n${items}`;
}

/**
 * Builds the system instruction for the review agent. It holds only content
 * that is identical for every PR of a repository (role + guidelines), so
 * Gemini's implicit prompt cache can reuse it across reviews; per-PR content
 * goes into {@link buildReviewUserPrompt}.
 */
export function buildReviewInstruction(
  input: Pick<ReviewAgentInput, 'workspace'>,
): string {
  return `${SYSTEM_ROLE_INSTRUCTION}${formatGuidelinesSection(input.workspace)}`;
}

function formatFocusSection(focusFiles: string[]): string {
  if (focusFiles.length === 0) {
    return '';
  }
  const items = focusFiles.map((file) => `- \`${file}\``).join('\n');
  return `\n\n### Focus Files\nTriage flagged these files as the riskiest in this PR. Review them first:\n${items}`;
}

function formatDiffSection(
  workspace: RepoWorkspace,
  maxInlineDiffChars: number,
): string {
  const prDiff = workspace.getPrDiff({ maxChars: maxInlineDiffChars });
  const { diff, changedFiles, truncated } = prDiff;
  const filesList = changedFiles.map((file) => `- \`${file}\``).join('\n');

  if (!truncated) {
    return `### Changed Files (${changedFiles.length})\n${filesList}\n\n### Annotated Unified Diff\n\`\`\`diff\n${diff}\n\`\`\``;
  }

  return `### Changed Files (${changedFiles.length})\n${filesList}\n\n*Note: The full annotated diff exceeds the inline threshold (${maxInlineDiffChars} chars). Use \`get_pr_diff({ path: "<file>" })\` to inspect the annotated diff for each changed file.*`;
}

const MAX_LISTED_THREADS = 30;

function formatThreadsSection(threads: ReviewThread[]): string {
  const current = threads
    .filter((t) => !t.isOutdated)
    .slice(0, MAX_LISTED_THREADS);
  if (current.length === 0) {
    return '';
  }
  const items = current
    .map((t) => {
      const opener = t.comments[0];
      const text = opener ? firstLine(opener.body, 140) : '';
      const author = opener ? ` by ${opener.author}` : '';
      return `- \`${threadLocation(t)}\` [${threadStatus(t)}]${author}: ${text}`;
    })
    .join('\n');
  return `\n\n### Existing Review Threads (Do Not Repeat)\nThese issues are already being discussed on this PR. Do NOT report them again:\n${items}`;
}

/** Per-PR sections that sit between the description and the diff. */
function formatPrContextSections(input: ReviewAgentInput): string {
  const priorSection = formatPriorFindingsSection(input.priorFindings ?? []);
  const threadsSection = formatThreadsSection(input.existingThreads ?? []);
  return `${priorSection}${threadsSection}${formatFocusSection(input.focusFiles ?? [])}`;
}

/**
 * Builds the user message containing PR metadata and the annotated diff.
 */
export function buildReviewUserPrompt(
  input: ReviewAgentInput,
  maxInlineDiffChars = DEFAULT_MAX_INLINE_DIFF_CHARS,
): string {
  const { prMeta, workspace } = input;
  const description = prMeta.body?.trim() || '_No description provided._';
  const diffSection = formatDiffSection(workspace, maxInlineDiffChars);
  const contextSections = formatPrContextSections(input);

  return `## Pull Request #${prMeta.prNumber}: ${prMeta.title}
- **Repository**: \`${prMeta.owner}/${prMeta.repo}\`
- **Author**: \`${prMeta.author}\`
- **Branch**: \`${prMeta.branch}\`

### Description
${description}${contextSections}

${diffSection}

Review the changes above, use repository tools only when needed to verify cross-file context, and call \`submit_review\` with your final review.`;
}

function resolveNumericOptions(options: ReviewAgentOptions): {
  maxLlmCalls: number;
  timeoutMs: number;
  maxInlineDiffChars: number;
} {
  return {
    maxLlmCalls: options.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS,
    timeoutMs: options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    maxInlineDiffChars:
      options.maxInlineDiffChars ?? DEFAULT_MAX_INLINE_DIFF_CHARS,
  };
}

function resolveReviewOptions(
  options: ReviewAgentOptions,
): ResolvedReviewOptions {
  return {
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    ...resolveNumericOptions(options),
  };
}

function buildSuccessResult(
  prMeta: PRMeta,
  submission: ValidatedReviewSubmission,
  priorFindings: PriorFinding[],
  usage: TokenUsage = emptyTokenUsage(),
): ReviewAgentResult {
  return {
    reviewResult: {
      provider: prMeta.provider,
      owner: prMeta.owner,
      repo: prMeta.repo,
      prNumber: prMeta.prNumber,
      summary: submission.summary,
      comments: submission.comments,
    },
    publishedFindings: [...priorFindings, ...submission.publishedFindings],
    findings: submission.findings,
    usage,
  };
}

/** A review result that posts only `summary`, with no inline comments. */
export function buildSummaryOnlyResult(
  prMeta: PRMeta,
  summary: string,
  priorFindings: PriorFinding[],
  usage: TokenUsage = emptyTokenUsage(),
): ReviewAgentResult {
  return buildSuccessResult(
    prMeta,
    { summary, comments: [], publishedFindings: [], findings: [] },
    priorFindings,
    usage,
  );
}

function buildFailureResult(
  prMeta: PRMeta,
  reason: string,
  priorFindings: PriorFinding[],
  usage: TokenUsage,
): ReviewAgentResult {
  return {
    reviewResult: {
      provider: prMeta.provider,
      owner: prMeta.owner,
      repo: prMeta.repo,
      prNumber: prMeta.prNumber,
      comments: [],
      summary: `Automated code review could not be completed: ${reason}`,
      failure: { reason },
    },
    publishedFindings: priorFindings,
    findings: [],
    usage,
  };
}

function getBestSubmission(
  state: SubmitReviewState,
): ValidatedReviewSubmission | undefined {
  return state.getAcceptedSubmission() ?? state.getFallbackDraft();
}

const NO_SUBMISSION_REASON =
  'Review agent finished without calling submit_review within the LLM call budget.';

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function extractErrorReason(outcome: AgentSessionOutcome): string {
  if (outcome.timedOut) {
    return 'Review timed out before completion.';
  }
  if (outcome.error === undefined) {
    return NO_SUBMISSION_REASON;
  }
  return describeError(outcome.error);
}

/** Uses the best submission the agent produced, even if the run later failed. */
function resolveOutcome(
  prMeta: PRMeta,
  state: SubmitReviewState,
  priorFindings: PriorFinding[],
  outcome: AgentSessionOutcome,
): ReviewAgentResult {
  const submission = getBestSubmission(state);
  if (submission) {
    return buildSuccessResult(prMeta, submission, priorFindings, outcome.usage);
  }
  return buildFailureResult(
    prMeta,
    extractErrorReason(outcome),
    priorFindings,
    outcome.usage,
  );
}

function createReviewAgent(
  input: ReviewAgentInput,
  resolved: ResolvedReviewOptions,
  submitBundle: SubmitReviewToolBundle,
): LlmAgent {
  const repoTools = createRepoTools(input.workspace);
  const instructionText = buildReviewInstruction(input);
  return new LlmAgent({
    name: 'code_review_agent',
    model: resolved.model,
    instruction: () => instructionText,
    ...thinkingConfig(resolved.thinkingLevel),
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    tools: [...repoTools.all, submitBundle.tool],
  });
}

async function executeAgentSession(
  input: ReviewAgentInput,
  priorFindings: PriorFinding[],
  resolved: ResolvedReviewOptions,
): Promise<ReviewAgentResult> {
  const submitBundle = createSubmitReviewTool(input.workspace, priorFindings);
  const outcome = await runAgentSession({
    agent: createReviewAgent(input, resolved, submitBundle),
    prompt: buildReviewUserPrompt(input, resolved.maxInlineDiffChars),
    maxLlmCalls: resolved.maxLlmCalls,
    timeoutMs: resolved.timeoutMs,
    isDone: () => Boolean(submitBundle.state.getAcceptedSubmission()),
  });
  return resolveOutcome(
    input.prMeta,
    submitBundle.state,
    priorFindings,
    outcome,
  );
}

/**
 * Executes the single-pass code review agent against an in-memory `RepoWorkspace`.
 * Short-circuits with 0 LLM calls when the PR contains no reviewable file changes.
 */
export async function runCodeReview(
  input: ReviewAgentInput,
  options: ReviewAgentOptions,
): Promise<ReviewAgentResult> {
  const priorFindings = input.priorFindings ?? [];
  const { changedFiles } = input.workspace.getPrDiff();

  if (changedFiles.length === 0) {
    return buildSummaryOnlyResult(
      input.prMeta,
      'No reviewable code changes in this pull request.',
      priorFindings,
    );
  }

  return executeAgentSession(
    input,
    priorFindings,
    resolveReviewOptions(options),
  );
}
