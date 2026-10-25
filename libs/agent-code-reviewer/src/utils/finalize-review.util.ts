import type { ReviewResultPayload } from '@code-review-agent/shared-types';
import { NonRetryableTaskError } from '@code-review-agent/shared-types';

import { LIMITS } from '../constants/limits.constant.js';
import { type Finding, type PriorFinding } from '../schemas/review.schema.js';
import {
  clampRangeToDiff,
  type LineRange,
  parseNewSideRanges,
} from '../tools/diff-anchors.util.js';

const SEVERITY_RANK: Record<'critical' | 'major' | 'minor', number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

/** Where the finalized review is addressed; always fixed by the runtime. */
export interface PublishTarget {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
}

interface DroppedFindingCounts {
  lowConfidence: number;
  unanchorable: number;
  duplicate: number;
  overCap: number;
}

interface FindingLike {
  path: string;
  startLine: number;
  endLine: number;
  title: string;
}

/** Word-boundary truncation so over-long bodies can't bloat PR comments. */
function truncateFindingBody(body: string): string {
  if (body.length <= LIMITS.maxFindingBodyChars) return body;
  const cut = body.slice(0, LIMITS.maxFindingBodyChars);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = cut.slice(0, lastSpace > 0 ? lastSpace : cut.length);
  return `${trimmed.trimEnd()} …`;
}

function normalizeTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  return new Set(tokens);
}

function shareTokens(titleA: string, titleB: string): boolean {
  const tokensA = extractTokens(titleA);
  const tokensB = extractTokens(titleB);
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  const shared = [...tokensA].filter((t) => tokensB.has(t)).length;
  // At least two shared tokens: a single common word ("leak", "check") is
  // weak evidence and would suppress genuinely distinct findings.
  return shared >= 2 && shared / Math.min(tokensA.size, tokensB.size) >= 0.5;
}

function haveOverlappingLines(a: FindingLike, b: FindingLike): boolean {
  return a.startLine <= b.endLine + 3 && b.startLine <= a.endLine + 3;
}

function titlesMatch(a: FindingLike, b: FindingLike): boolean {
  const normA = normalizeTitle(a.title);
  const normB = normalizeTitle(b.title);
  return normA.length > 0 && normA === normB;
}

/**
 * Strict intra-batch dedup. Findings anchored against the same diff have
 * stable line numbers, so line proximity is required: two genuinely distinct
 * defects in one file that happen to share a title (e.g. "Missing null check"
 * at lines 10 and 250) must both survive.
 */
export function isDuplicateFinding(a: FindingLike, b: FindingLike): boolean {
  if (a.path !== b.path) return false;
  return (
    haveOverlappingLines(a, b) &&
    (titlesMatch(a, b) || shareTokens(a.title, b.title))
  );
}

/**
 * Dedup against findings published by PREVIOUS review runs. Commits shift line
 * numbers between runs, so line proximity is unreliable here — require strong
 * title evidence on the same file instead. The prompt-level prior-findings
 * list (which reviewers see with their original lines) covers the cases where
 * the same defect gets re-worded beyond token overlap.
 */
export function isPriorDuplicate(
  finding: FindingLike,
  prior: FindingLike,
): boolean {
  if (finding.path !== prior.path) return false;
  return titlesMatch(finding, prior) || shareTokens(finding.title, prior.title);
}

/** Builds the fixed publish target from the PR under review. */
export function buildPublishTarget(meta: {
  provider?: string;
  owner?: string;
  repo?: string;
  number?: number;
}): PublishTarget {
  return {
    provider: meta.provider || 'github',
    owner: meta.owner || '',
    repo: meta.repo || '',
    prNumber: meta.number || 0,
  };
}

function assertPublishableTarget(target: PublishTarget): void {
  if (!target.owner || !target.repo || !target.prNumber) {
    // Deterministic: a redelivery would fail identically.
    throw new NonRetryableTaskError(
      'Repository owner, name, and PR number are required to publish review results.',
    );
  }
}
function filterHighConfidence(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.confidence >= LIMITS.confidenceThreshold);
}

function normalizeFindingRange(f: Finding): LineRange {
  const a = f.startLine || f.endLine || 1;
  const b = f.endLine || a;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function clampFindingToHunks(
  ranges: Map<string, LineRange[]>,
  f: Finding,
): Finding[] {
  const { start, end } = normalizeFindingRange(f);
  const clamped = clampRangeToDiff(ranges, f.path, start, end);
  if (!clamped) return [];
  return [
    {
      ...f,
      startLine: clamped.start,
      endLine: clamped.end,
    },
  ];
}

function clampToDiffHunks(findings: Finding[], diff: string): Finding[] {
  if (!diff.trim()) {
    return findings.map((f) => {
      const { start, end } = normalizeFindingRange(f);
      return { ...f, startLine: start, endLine: end };
    });
  }
  const ranges = parseNewSideRanges(diff);
  return findings.flatMap((f) => clampFindingToHunks(ranges, f));
}

function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.confidence - a.confidence,
  );
}

function selectPublishableFindings(
  findings: Finding[],
  diff: string,
  priorFindings: PriorFinding[] = [],
): { kept: Finding[]; dropped: DroppedFindingCounts } {
  // Guardrails enforced in code, not just in the prompt: confidence is
  // required by the schema (cannot be bypassed by omission).
  const highConfidence = filterHighConfidence(findings);

  // Anchor validation: GitHub rejects inline comments on lines outside
  // the diff, so drop un-anchorable findings here instead of paying for
  // a failing API call per comment (and reporting it after the fact).
  const anchorable = clampToDiffHunks(highConfidence, diff);
  const ranked = rankFindings(anchorable);

  const deduped: Finding[] = [];
  let duplicateCount = 0;

  for (const finding of ranked) {
    const isDup =
      priorFindings.some((prior) => isPriorDuplicate(finding, prior)) ||
      deduped.some((existing) => isDuplicateFinding(finding, existing));

    if (isDup) {
      duplicateCount++;
    } else {
      deduped.push(finding);
    }
  }

  // Runaway guard: `ranked` is severity-first, so the cap keeps the most
  // important findings, not the first ones the model happened to emit.
  const kept = deduped.slice(0, LIMITS.maxFindingsPerReview);

  return {
    kept,
    dropped: {
      lowConfidence: findings.length - highConfidence.length,
      unanchorable: highConfidence.length - anchorable.length,
      duplicate: duplicateCount,
      overCap: deduped.length - kept.length,
    },
  };
}

function buildReviewComment(f: Finding) {
  // Findings point at the problem; fix code is deliberately not part
  // of the contract — teams never applied the ```suggestion blocks and
  // they were the largest per-comment token cost.
  const commentBody = `### [${f.severity.toUpperCase()}] ${f.title}\n\n${truncateFindingBody(f.body)}`;
  return {
    path: f.path,
    // NEW-side line numbers; the provider adapter maps these to
    // start_line/line so multi-line findings anchor to their range.
    startPosition: f.startLine === f.endLine ? undefined : f.startLine,
    position: f.endLine,
    body: commentBody,
  };
}

function buildDroppedNotes(dropped: DroppedFindingCounts): string[] {
  const notes: string[] = [];
  if (dropped.lowConfidence > 0) {
    notes.push(`dropped ${dropped.lowConfidence} low-confidence`);
  }
  if (dropped.unanchorable > 0) {
    notes.push(
      `dropped ${dropped.unanchorable} unanchorable (start/end line outside the diff hunks of that file)`,
    );
  }
  if (dropped.duplicate > 0) {
    notes.push(`dropped ${dropped.duplicate} duplicate`);
  }
  if (dropped.overCap > 0) {
    notes.push(`capped ${dropped.overCap} over-limit`);
  }
  return notes;
}

function describeDroppedFindings(dropped: DroppedFindingCounts): string {
  const droppedNotes = buildDroppedNotes(dropped).join(', ');
  return droppedNotes ? ` (${droppedNotes})` : '';
}

function buildPublishAcknowledgement(
  commentCount: number,
  dropped: DroppedFindingCounts,
): string {
  return `Successfully recorded ${commentCount} review findings and summary.${describeDroppedFindings(dropped)}`;
}

export interface FinalizeReviewArgs {
  summary?: string;
  findings: Finding[];
  /** The same (filtered, prepared) diff the reviewer agents saw. */
  diff: string;
  priorFindings?: PriorFinding[];
  /** Fixed by the runtime from the PR under review — never model input. */
  target: PublishTarget;
}

export interface FinalizedReview {
  payload: ReviewResultPayload;
  /** This run's kept findings, shaped for persistence as prior findings. */
  publishedFindings: PriorFinding[];
  acknowledgement: string;
}

/**
 * Deterministic post-processing of the orchestrator's final report. All
 * guardrails are enforced here in code (confidence floor, diff anchoring,
 * dedup against prior findings, per-review cap, body truncation), and the
 * publish target is pinned by the caller — nothing in the model's output can
 * redirect or multiply the published review. Publishing itself is the host's
 * job (core pushes the returned payload exactly once).
 */
export function finalizeReview(args: FinalizeReviewArgs): FinalizedReview {
  assertPublishableTarget(args.target);
  const { kept, dropped } = selectPublishableFindings(
    args.findings,
    args.diff,
    args.priorFindings ?? [],
  );
  const comments = kept.map(buildReviewComment);

  const payload: ReviewResultPayload = {
    provider: args.target.provider,
    owner: args.target.owner,
    repo: args.target.repo,
    prNumber: args.target.prNumber,
    comments,
    summary: args.summary,
  };

  const publishedFindings: PriorFinding[] = kept.map((f) => ({
    path: f.path,
    startLine: f.startLine,
    endLine: f.endLine,
    severity: f.severity,
    title: f.title,
  }));

  return {
    payload,
    publishedFindings,
    acknowledgement: buildPublishAcknowledgement(comments.length, dropped),
  };
}
