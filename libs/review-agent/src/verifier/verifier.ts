import {
  createFindFilesTool,
  createGrepCodeTool,
  createReadFileTool,
  type RepoWorkspace,
} from '@code-review-agent/agent-tools';
import type { PRMeta, TokenUsage } from '@code-review-agent/shared-types';
import { type BaseLlm, LlmAgent } from '@google/adk';
import type { ThinkingLevel } from '@google/genai';

import { runAgentSession, thinkingConfig } from '../agents/agent-session.js';
import type { AnchoredFinding } from '../tools/submit-review.tool.js';
import {
  createSubmitVerdictsTool,
  type FindingVerdict,
  type SubmitVerdictsInput,
} from './submit-verdicts.tool.js';

const MAX_FILE_DIFF_CHARS = 6_000;

const VERIFIER_ROLE_INSTRUCTION = `You are a Staff Software Engineer verifying candidate findings from a first-pass code reviewer before they are posted on a Pull Request.

For each candidate, decide whether it is a real, actionable defect introduced or exposed by this PR:
- **keep** only when the code supports the claim: check the diff hunk, and use \`read_file\`, \`grep_code\` or \`find_files\` when the claim depends on callers, types or code outside the hunk.
- **drop** false positives, nitpicks, style preferences, speculative risks, issues the PR already handles, and claims you cannot confirm.
- Correct \`severity\` only when it is clearly wrong: critical (security/crash/data loss), major (broken behavior/race/contract break), minor (localized bug/guideline violation).
- Keep tool use minimal; most verdicts need no tools.

Finish by calling \`submit_verdicts\` once with a verdict for every candidate id. Rewrite \`summary\` only if the dropped findings make the original summary wrong.`;

export interface VerifierInput {
  prMeta: PRMeta;
  workspace: RepoWorkspace;
  /** Reviewer summary, rewritten by the verifier if it no longer fits. */
  summary: string;
  findings: AnchoredFinding[];
}

export interface VerifierOptions {
  model: BaseLlm;
  timeoutMs: number;
  maxLlmCalls: number;
  thinkingLevel?: ThinkingLevel;
}

export interface VerifierResult {
  /** Kept findings, with corrected severities. All findings if verification failed. */
  findings: AnchoredFinding[];
  summary: string;
  /** False when the verifier failed and every finding was kept unchecked. */
  verified: boolean;
  usage: TokenUsage;
}

function formatGuidelines(workspace: RepoWorkspace): string {
  const guidelines = workspace.getRepoGuidelines();
  return guidelines ? `\n\n## Repository Guidelines\n\n${guidelines}` : '';
}

/** Role + repo guidelines only, so the prefix is shared across a repo's PRs. */
export function buildVerifierInstruction(workspace: RepoWorkspace): string {
  return `${VERIFIER_ROLE_INSTRUCTION}${formatGuidelines(workspace)}`;
}

function formatCandidate(item: AnchoredFinding, id: number): string {
  const { finding, anchor } = item;
  const lines =
    anchor.startLine !== undefined
      ? `${anchor.startLine}-${anchor.line}`
      : `${anchor.line}`;
  const suggestion = finding.suggestion
    ? `\n- Suggested fix:\n\`\`\`\n${finding.suggestion}\n\`\`\``
    : '';
  return `### Candidate ${id}: [${finding.severity.toUpperCase()}] ${finding.title}
- File: \`${finding.path}\` lines ${lines}
- Claim: ${finding.comment}${suggestion}`;
}

function formatHunks(input: VerifierInput): string {
  const paths = [...new Set(input.findings.map((item) => item.finding.path))];
  return paths
    .map((path) => {
      const { diff } = input.workspace.getPrDiff({
        path,
        maxChars: MAX_FILE_DIFF_CHARS,
      });
      return `### \`${path}\`\n\`\`\`diff\n${diff}\n\`\`\``;
    })
    .join('\n\n');
}

export function buildVerifierPrompt(input: VerifierInput): string {
  const candidates = input.findings.map(formatCandidate).join('\n\n');
  return `## Pull Request #${input.prMeta.prNumber}: ${input.prMeta.title}

### Reviewer summary
${input.summary}

## Candidate findings
${candidates}

## Diff of the files involved
${formatHunks(input)}`;
}

function applyVerdict(
  item: AnchoredFinding,
  verdict: FindingVerdict | undefined,
): AnchoredFinding | null {
  // A candidate the verifier did not rule on is kept: fail open per finding.
  if (!verdict) return item;
  if (verdict.verdict === 'drop') return null;
  if (!verdict.severity) return item;
  return { ...item, finding: { ...item.finding, severity: verdict.severity } };
}

function applyVerdicts(
  input: VerifierInput,
  submission: SubmitVerdictsInput,
): Pick<VerifierResult, 'findings' | 'summary'> {
  const byId = new Map(submission.verdicts.map((v) => [v.id, v]));
  const findings = input.findings
    .map((item, id) => applyVerdict(item, byId.get(id)))
    .filter((item): item is AnchoredFinding => item !== null);
  const summary = submission.summary?.trim() || input.summary;
  return { findings, summary };
}

/**
 * Runs the verifier agent over the reviewer's candidate findings. Fails open:
 * if it errors, times out or never submits, every finding is kept.
 */
export async function runVerifier(
  input: VerifierInput,
  options: VerifierOptions,
): Promise<VerifierResult> {
  const verdicts = createSubmitVerdictsTool();
  const agent = new LlmAgent({
    name: 'finding_verifier_agent',
    model: options.model,
    instruction: buildVerifierInstruction(input.workspace),
    ...thinkingConfig(options.thinkingLevel),
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    tools: [
      createReadFileTool(input.workspace),
      createGrepCodeTool(input.workspace),
      createFindFilesTool(input.workspace),
      verdicts.tool,
    ],
  });
  const outcome = await runAgentSession({
    agent,
    prompt: buildVerifierPrompt(input),
    maxLlmCalls: options.maxLlmCalls,
    timeoutMs: options.timeoutMs,
    isDone: () => Boolean(verdicts.getSubmission()),
  });
  const submission = verdicts.getSubmission();
  if (!submission) {
    const { findings, summary } = input;
    return { findings, summary, verified: false, usage: outcome.usage };
  }
  return {
    ...applyVerdicts(input, submission),
    verified: true,
    usage: outcome.usage,
  };
}
