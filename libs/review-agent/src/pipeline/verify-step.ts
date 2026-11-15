import type { RepoWorkspace } from '@code-review-agent/agent-tools';
import type {
  PriorFinding,
  PRMeta,
  TokenUsage,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { ThinkingLevel } from '@google/genai';

import type { ReviewAgentResult } from '../review-agent.js';
import type { AnchoredFinding } from '../tools/submit-review.tool.js';
import { runVerifier } from '../verifier/verifier.js';
import { withFindings } from './result-findings.js';

/** The verifier never gets more than this, whatever the overall budget. */
const MAX_VERIFIER_TIMEOUT_MS = 120_000;
/** Below this much remaining time the verifier is skipped (findings kept). */
const MIN_VERIFIER_BUDGET_MS = 20_000;
/** Time kept back for publishing after the verifier. */
const PUBLISH_RESERVE_MS = 5_000;

const VERIFIER_PROFILES = {
  light: { thinkingLevel: ThinkingLevel.MEDIUM, maxLlmCalls: 4 },
  deep: { thinkingLevel: ThinkingLevel.HIGH, maxLlmCalls: 6 },
} as const;

export interface VerifyStepInput {
  prMeta: PRMeta;
  workspace: RepoWorkspace;
  tier: 'light' | 'deep';
  result: ReviewAgentResult;
  priorFindings: PriorFinding[];
  model: BaseLlm;
  remainingMs: number;
  /** Earlier review-thread discussion per finding, shown to the verifier. */
  context?: Map<AnchoredFinding, string>;
}

export interface VerifyStepResult {
  result: ReviewAgentResult;
  /** Sentence for the summary footer, or empty when nothing was checked. */
  note: string;
  usage?: TokenUsage;
}

function isSevere(item: AnchoredFinding): boolean {
  return item.finding.severity !== 'minor';
}

/**
 * Deep reviews verify every finding. Light reviews verify only major and
 * critical findings; minor ones are published as the reviewer wrote them.
 */
export function selectCandidates(
  tier: 'light' | 'deep',
  findings: AnchoredFinding[],
): AnchoredFinding[] {
  return tier === 'deep' ? findings : findings.filter(isSevere);
}

/** Keeps unchecked findings in place and swaps checked ones for the verdicts. */
function mergeVerified(
  all: AnchoredFinding[],
  candidates: AnchoredFinding[],
  kept: AnchoredFinding[],
): AnchoredFinding[] {
  const checked = new Set(candidates);
  const keptByOriginal = new Map(
    candidates.map((c) => [c, kept.find((k) => k.anchor === c.anchor)]),
  );
  return all
    .map((item) => (checked.has(item) ? keptByOriginal.get(item) : item))
    .filter((item): item is AnchoredFinding => item !== undefined);
}

function verifierTimeout(remainingMs: number): number {
  return Math.min(MAX_VERIFIER_TIMEOUT_MS, remainingMs - PUBLISH_RESERVE_MS);
}

/** Returns the unchanged result when there is nothing to check or no time. */
function skipVerification(
  input: VerifyStepInput,
  candidates: AnchoredFinding[],
): VerifyStepResult | null {
  const { result } = input;
  if (result.reviewResult.failure || candidates.length === 0) {
    return { result, note: '' };
  }
  if (verifierTimeout(input.remainingMs) < MIN_VERIFIER_BUDGET_MS) {
    return { result, note: 'Findings were not double-checked (no time left).' };
  }
  return null;
}

/**
 * Lets the verifier model confirm or drop the reviewer's findings. Fails
 * open: without enough time, or if the verifier fails, findings are kept.
 */
export async function verifyStep(
  input: VerifyStepInput,
): Promise<VerifyStepResult> {
  const { result, tier } = input;
  const candidates = selectCandidates(tier, result.findings);
  const skipped = skipVerification(input, candidates);
  if (skipped) return skipped;
  const timeoutMs = verifierTimeout(input.remainingMs);
  const verified = await runVerifier(
    {
      prMeta: input.prMeta,
      workspace: input.workspace,
      summary: result.reviewResult.summary ?? '',
      findings: candidates,
      context: input.context,
    },
    { model: input.model, timeoutMs, ...VERIFIER_PROFILES[tier] },
  );
  if (!verified.verified) {
    return {
      result,
      note: 'Findings were not double-checked (verifier unavailable).',
      usage: verified.usage,
    };
  }
  const merged = mergeVerified(result.findings, candidates, verified.findings);
  return {
    result: withFindings(result, merged, input.priorFindings, verified.summary),
    note: `Verifier kept ${verified.findings.length} of ${candidates.length} checked findings.`,
    usage: verified.usage,
  };
}
