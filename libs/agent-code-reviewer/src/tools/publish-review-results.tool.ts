import type { ReviewResultPayload } from '@code-review-agent/shared-types';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { LIMITS } from '../constants/limits.constant.js';
import { type PrMeta, STATE } from '../constants/state-keys.constant.js';
import { findingSchema } from '../schemas/review.schema.js';
import { isLineInDiff, parseNewSideRanges } from './diff-anchors.util.js';

const SEVERITY_RANK: Record<'critical' | 'major' | 'minor', number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

/** Word-boundary truncation so over-long bodies can't bloat PR comments. */
function truncateFindingBody(body: string): string {
  if (body.length <= LIMITS.maxFindingBodyChars) return body;
  const cut = body.slice(0, LIMITS.maxFindingBodyChars);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = cut.slice(0, lastSpace > 0 ? lastSpace : cut.length);
  return `${trimmed.trimEnd()} …`;
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
      const meta = ctx?.state?.get<PrMeta>(STATE.prMeta);

      const provider = meta?.provider || 'github';
      const owner = meta?.owner || '';
      const repo = meta?.repo || '';
      const prNumber = meta?.number || 0;

      if (!owner || !repo || !prNumber) {
        throw new Error(
          'Repository owner, name, and PR number are required to publish review results.',
        );
      }

      // Guardrails enforced in code, not just in the prompt: confidence is
      // required by the schema (cannot be bypassed by omission), and the
      // findings cap is applied here after severity/confidence ranking.
      const highConfidence = input.findings.filter(
        (f) => f.confidence >= LIMITS.confidenceThreshold,
      );
      const droppedLowConfidence =
        input.findings.length - highConfidence.length;

      // Anchor validation: GitHub rejects inline comments on lines outside
      // the diff, so drop un-anchorable findings here instead of paying for
      // a failing API call per comment (and reporting it after the fact).
      const diff = ctx?.state?.get<string>(STATE.diff) ?? '';
      let anchorable = highConfidence;
      let droppedUnanchorable = 0;
      if (diff.trim()) {
        const ranges = parseNewSideRanges(diff);
        anchorable = highConfidence.filter((f) => {
          const endLine = f.endLine || f.startLine || 1;
          const startLine = Math.min(f.startLine || endLine, endLine);
          return (
            isLineInDiff(ranges, f.path, startLine) &&
            isLineInDiff(ranges, f.path, endLine)
          );
        });
        droppedUnanchorable = highConfidence.length - anchorable.length;
      }

      const ranked = [...anchorable].sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          b.confidence - a.confidence,
      );
      const kept = ranked.slice(0, LIMITS.maxFindings);
      const droppedOverCap = ranked.length - kept.length;

      const comments = kept.map((f) => {
        // Findings point at the problem; fix code is deliberately not part
        // of the contract — teams never applied the ```suggestion blocks and
        // they were the largest per-comment token cost.
        const commentBody = `### [${f.severity.toUpperCase()}] ${f.title}\n\n${truncateFindingBody(f.body)}`;
        const endLine = f.endLine || f.startLine || 1;
        const startLine = Math.min(f.startLine || endLine, endLine);
        return {
          path: f.path,
          // NEW-side line numbers; the provider adapter maps these to
          // start_line/line so multi-line findings anchor to their range.
          startPosition: startLine === endLine ? undefined : startLine,
          position: endLine,
          body: commentBody,
        };
      });

      const payload: ReviewResultPayload = {
        provider,
        owner,
        repo,
        prNumber,
        comments,
        summary: input.summary,
        ticketCoverage: input.ticketCoverage,
      };

      ctx?.state?.set(STATE.reviewResult, payload);

      if (deps.onPublishResult) {
        await deps.onPublishResult(payload);
      }

      const droppedNotes = [
        droppedLowConfidence > 0
          ? `dropped ${droppedLowConfidence} low-confidence`
          : null,
        droppedUnanchorable > 0
          ? `dropped ${droppedUnanchorable} unanchorable (start/end line outside the diff hunks of that file)`
          : null,
        droppedOverCap > 0 ? `capped ${droppedOverCap} over-limit` : null,
      ]
        .filter(Boolean)
        .join(', ');

      return `Successfully recorded ${comments.length} review findings and summary.${droppedNotes ? ` (${droppedNotes})` : ''}`;
    },
  });
}
