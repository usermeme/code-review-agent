import type { ReviewResultPayload } from '@code-review-agent/shared-types';
import { type Context, FunctionTool } from '@google/adk';
import { z } from 'zod';

import { LIMITS } from '../constants/limits.constant.js';
import { type PrMeta, STATE } from '../constants/state-keys.constant.js';
import { findingSchema } from '../schemas/review.schema.js';
import {
  clampRangeToDiff,
  type LineRange,
  parseNewSideRanges,
} from './diff-anchors.util.js';

const SEVERITY_RANK: Record<'critical' | 'major' | 'minor', number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

type Finding = z.infer<typeof findingSchema>;

type SessionState = Context['state'];

interface PublishTarget {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
}

interface DroppedFindingCounts {
  lowConfidence: number;
  unanchorable: number;
  overCap: number;
}

/** Word-boundary truncation so over-long bodies can't bloat PR comments. */
function truncateFindingBody(body: string): string {
  if (body.length <= LIMITS.maxFindingBodyChars) return body;
  const cut = body.slice(0, LIMITS.maxFindingBodyChars);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = cut.slice(0, lastSpace > 0 ? lastSpace : cut.length);
  return `${trimmed.trimEnd()} …`;
}

function readPublishTarget(meta: Partial<PrMeta>): PublishTarget {
  return {
    provider: meta.provider || 'github',
    owner: meta.owner || '',
    repo: meta.repo || '',
    prNumber: meta.number || 0,
  };
}

function readPublishContext(ctx: Context | undefined) {
  const state = ctx?.state;
  return {
    state,
    target: readPublishTarget(state?.get<PrMeta>(STATE.prMeta) ?? {}),
  };
}

function readReviewDiff(state: SessionState | undefined): string {
  return state?.get<string>(STATE.diff) ?? '';
}

function assertPublishableTarget(target: PublishTarget): void {
  if (!target.owner || !target.repo || !target.prNumber) {
    throw new Error(
      'Repository owner, name, and PR number are required to publish review results.',
    );
  }
}

function filterHighConfidence(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.confidence >= LIMITS.confidenceThreshold);
}

function readFindingEndLine(f: Finding): number {
  return f.endLine || f.startLine || 1;
}

function readFindingStartLine(f: Finding): number {
  return Math.min(f.startLine || readFindingEndLine(f), readFindingEndLine(f));
}

function clampFindingToHunks(
  ranges: Map<string, LineRange[]>,
  f: Finding,
): Finding[] {
  const endLine = readFindingEndLine(f);
  const startLine = readFindingStartLine(f);
  const clamped = clampRangeToDiff(ranges, f.path, startLine, endLine);
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
    return findings;
  }
  const ranges = parseNewSideRanges(diff);
  return findings.flatMap((f) => clampFindingToHunks(ranges, f));
}

function rankAndCapFindings(findings: Finding[]): Finding[] {
  const ranked = [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.confidence - a.confidence,
  );
  return ranked.slice(0, LIMITS.maxFindings);
}

function selectPublishableFindings(
  findings: Finding[],
  diff: string,
): { kept: Finding[]; dropped: DroppedFindingCounts } {
  // Guardrails enforced in code, not just in the prompt: confidence is
  // required by the schema (cannot be bypassed by omission), and the
  // findings cap is applied here after severity/confidence ranking.
  const highConfidence = filterHighConfidence(findings);

  // Anchor validation: GitHub rejects inline comments on lines outside
  // the diff, so drop un-anchorable findings here instead of paying for
  // a failing API call per comment (and reporting it after the fact).
  const anchorable = clampToDiffHunks(highConfidence, diff);
  const kept = rankAndCapFindings(anchorable);

  return {
    kept,
    dropped: {
      lowConfidence: findings.length - highConfidence.length,
      unanchorable: highConfidence.length - anchorable.length,
      overCap: anchorable.length - kept.length,
    },
  };
}

function buildReviewComment(f: Finding) {
  // Findings point at the problem; fix code is deliberately not part
  // of the contract — teams never applied the ```suggestion blocks and
  // they were the largest per-comment token cost.
  const commentBody = `### [${f.severity.toUpperCase()}] ${f.title}\n\n${truncateFindingBody(f.body)}`;
  const endLine = readFindingEndLine(f);
  const startLine = readFindingStartLine(f);
  return {
    path: f.path,
    // NEW-side line numbers; the provider adapter maps these to
    // start_line/line so multi-line findings anchor to their range.
    startPosition: startLine === endLine ? undefined : startLine,
    position: endLine,
    body: commentBody,
  };
}

function describeDroppedFindings(dropped: DroppedFindingCounts): string {
  const droppedNotes = [
    dropped.lowConfidence > 0
      ? `dropped ${dropped.lowConfidence} low-confidence`
      : null,
    dropped.unanchorable > 0
      ? `dropped ${dropped.unanchorable} unanchorable (start/end line outside the diff hunks of that file)`
      : null,
    dropped.overCap > 0 ? `capped ${dropped.overCap} over-limit` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return droppedNotes ? ` (${droppedNotes})` : '';
}

function buildPublishAcknowledgement(
  commentCount: number,
  dropped: DroppedFindingCounts,
): string {
  return `Successfully recorded ${commentCount} review findings and summary.${describeDroppedFindings(dropped)}`;
}

export interface PublishReviewResultsToolDependencies {
  onPublishResult?: (payload: ReviewResultPayload) => Promise<void> | void;
}

export function createPublishReviewResultsTool(
  deps: PublishReviewResultsToolDependencies = {},
) {
  return new FunctionTool({
    name: 'publishReviewResults',
    description:
      'Publishes the final review findings and comments so they can be processed and posted inline to GitHub. ' +
      `Findings below confidence ${LIMITS.confidenceThreshold} are dropped, findings whose lines fall outside the diff hunks of their file are dropped ` +
      `(GitHub cannot anchor them), and the list is capped at ${LIMITS.maxFindings} (highest severity first). ` +
      'Bodies over the length cap are truncated. Keep every finding body to the problem and its failure scenario — never fix code.',
    // Coordinates are NOT model-facing: the publish target is fixed to the
    // PR under review (session-state prMeta) so a prompt-injected agent
    // cannot redirect the published review to another repository or PR.
    parameters: z.object({
      summary: z
        .string()
        .describe('Overall summary verdict of the code review'),
      ticketCoverage: z
        .string()
        .optional()
        .describe('Analysis of linked ticket implementation'),
      findings: z
        .array(findingSchema)
        .describe('List of approved review findings to post inline'),
    }),
    execute: async (input, ctx) => {
      const { state, target } = readPublishContext(ctx);
      assertPublishableTarget(target);
      const diff = readReviewDiff(state);
      const { kept, dropped } = selectPublishableFindings(input.findings, diff);
      const comments = kept.map(buildReviewComment);

      const payload: ReviewResultPayload = {
        provider: target.provider,
        owner: target.owner,
        repo: target.repo,
        prNumber: target.prNumber,
        comments,
        summary: input.summary,
        ticketCoverage: input.ticketCoverage,
      };

      state?.set(STATE.reviewResult, payload);

      if (deps.onPublishResult) {
        await deps.onPublishResult(payload);
      }

      return buildPublishAcknowledgement(comments.length, dropped);
    },
  });
}
