import {
  createRepoTools,
  type RepoWorkspace,
} from '@code-review-agent/agent-tools';
import type {
  PriorFinding,
  PRMeta,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import { type BaseLlm, InMemoryRunner, LlmAgent } from '@google/adk';

import {
  createSubmitReviewTool,
  type SubmitReviewState,
  type SubmitReviewToolBundle,
  type ValidatedReviewSubmission,
} from './tools/submit-review.tool.js';

export const DEFAULT_REVIEW_MODEL = 'gemini-2.5-flash';
export const DEFAULT_MAX_LLM_CALLS = 10;
export const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_INLINE_DIFF_CHARS = 80_000;

export interface ReviewAgentInput {
  prMeta: PRMeta;
  workspace: RepoWorkspace;
  priorFindings?: PriorFinding[];
}

export interface ReviewAgentOptions {
  /**
   * Model name (e.g. 'gemini-2.5-flash') or a BaseLlm instance for testing.
   * Defaults to process.env['GEMINI_MODEL'] || 'gemini-2.5-flash'.
   */
  model?: string | BaseLlm;
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
}

export interface ReviewAgentResult {
  reviewResult: ReviewResultPayload;
  publishedFindings: PriorFinding[];
}

interface ResolvedReviewOptions {
  model: string | BaseLlm;
  maxLlmCalls: number;
  timeoutMs: number;
  maxInlineDiffChars: number;
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
  return `\n\n## Already Published Findings (Do Not Repeat)\nThe following findings were already posted on earlier commits of this PR. Do NOT report them again:\n${items}`;
}

/**
 * Builds the system instruction for the single-pass review agent.
 */
export function buildReviewInstruction(input: ReviewAgentInput): string {
  const guidelinesSection = formatGuidelinesSection(input.workspace);
  const priorSection = formatPriorFindingsSection(input.priorFindings ?? []);
  return `${SYSTEM_ROLE_INSTRUCTION}${guidelinesSection}${priorSection}`;
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

  return `## Pull Request #${prMeta.prNumber}: ${prMeta.title}
- **Repository**: \`${prMeta.owner}/${prMeta.repo}\`
- **Author**: \`${prMeta.author}\`
- **Branch**: \`${prMeta.branch}\`

### Description
${description}

${diffSection}

Review the changes above, use repository tools only when needed to verify cross-file context, and call \`submit_review\` with your final review.`;
}

function resolveDefaultModel(modelOption?: string | BaseLlm): string | BaseLlm {
  if (modelOption !== undefined) {
    return modelOption;
  }
  return process.env['GEMINI_MODEL']?.trim() || DEFAULT_REVIEW_MODEL;
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
    model: resolveDefaultModel(options.model),
    ...resolveNumericOptions(options),
  };
}

function buildSuccessResult(
  prMeta: PRMeta,
  submission: ValidatedReviewSubmission,
  priorFindings: PriorFinding[],
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
  };
}

function buildFailureResult(
  prMeta: PRMeta,
  reason: string,
  priorFindings: PriorFinding[],
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
  };
}

function getBestSubmission(
  state: SubmitReviewState,
): ValidatedReviewSubmission | undefined {
  return state.getAcceptedSubmission() ?? state.getFallbackDraft();
}

function resolveFinalSubmission(
  prMeta: PRMeta,
  state: SubmitReviewState,
  priorFindings: PriorFinding[],
): ReviewAgentResult {
  const submission = getBestSubmission(state);
  if (submission) {
    return buildSuccessResult(prMeta, submission, priorFindings);
  }
  return buildFailureResult(
    prMeta,
    'Review agent finished without calling submit_review within the LLM call budget.',
    priorFindings,
  );
}

function createReviewRunner(
  input: ReviewAgentInput,
  model: string | BaseLlm,
  submitBundle: SubmitReviewToolBundle,
): InMemoryRunner {
  const repoTools = createRepoTools(input.workspace);
  const instructionText = buildReviewInstruction(input);
  const agent = new LlmAgent({
    name: 'code_review_agent',
    model,
    instruction: () => instructionText,
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    tools: [...repoTools.all, submitBundle.tool],
  });

  return new InMemoryRunner({
    appName: 'code-review-agent',
    agent,
  });
}

async function driveRunnerLoop(
  runner: InMemoryRunner,
  userPrompt: string,
  maxLlmCalls: number,
  abortSignal: AbortSignal,
  state: SubmitReviewState,
): Promise<void> {
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId: 'pr-reviewer',
  });

  const events = runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: userPrompt }] },
    runConfig: { maxLlmCalls },
    abortSignal,
  });

  for await (const event of events) {
    if (event && state.getAcceptedSubmission()) {
      break;
    }
  }
}

function extractErrorReason(error: unknown, timedOut: boolean): string {
  if (timedOut) {
    return 'Review timed out before completion.';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function handleRunnerError(
  prMeta: PRMeta,
  state: SubmitReviewState,
  priorFindings: PriorFinding[],
  error: unknown,
  timedOut: boolean,
): ReviewAgentResult {
  const fallback = getBestSubmission(state);
  if (fallback) {
    return buildSuccessResult(prMeta, fallback, priorFindings);
  }
  return buildFailureResult(
    prMeta,
    extractErrorReason(error, timedOut),
    priorFindings,
  );
}

async function executeAgentSession(
  input: ReviewAgentInput,
  priorFindings: PriorFinding[],
  resolved: ResolvedReviewOptions,
): Promise<ReviewAgentResult> {
  const submitBundle = createSubmitReviewTool(input.workspace, priorFindings);
  const runner = createReviewRunner(input, resolved.model, submitBundle);
  const userPrompt = buildReviewUserPrompt(input, resolved.maxInlineDiffChars);

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, resolved.timeoutMs);

  try {
    await driveRunnerLoop(
      runner,
      userPrompt,
      resolved.maxLlmCalls,
      abortController.signal,
      submitBundle.state,
    );
    return resolveFinalSubmission(
      input.prMeta,
      submitBundle.state,
      priorFindings,
    );
  } catch (error: unknown) {
    return handleRunnerError(
      input.prMeta,
      submitBundle.state,
      priorFindings,
      error,
      timedOut,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Executes the single-pass code review agent against an in-memory `RepoWorkspace`.
 * Short-circuits with 0 LLM calls when the PR contains no reviewable file changes.
 */
export async function runCodeReview(
  input: ReviewAgentInput,
  options: ReviewAgentOptions = {},
): Promise<ReviewAgentResult> {
  const priorFindings = input.priorFindings ?? [];
  const { changedFiles } = input.workspace.getPrDiff();

  if (changedFiles.length === 0) {
    return buildSuccessResult(
      input.prMeta,
      {
        summary: 'No reviewable code changes in this pull request.',
        comments: [],
        publishedFindings: [],
      },
      priorFindings,
    );
  }

  return executeAgentSession(
    input,
    priorFindings,
    resolveReviewOptions(options),
  );
}
