import type { ReviewResultPayload } from '@code-review-agent/shared-types';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { LIMITS } from '../constants/limits.constant.js';
import { type PrMeta, STATE } from '../constants/state-keys.constant.js';
import { findingSchema } from '../schemas/review.schema.js';

const SEVERITY_RANK: Record<'critical' | 'major' | 'minor', number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

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
      `Findings below confidence ${LIMITS.confidenceThreshold} are dropped and the list is capped at ${LIMITS.maxFindings} (highest severity first).`,
    parameters: z.object({
      provider: z.string().optional().describe('Git provider (e.g. github)'),
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      prNumber: z.number().optional().describe('Pull request number'),
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

      const provider = input.provider || meta?.provider || 'github';
      const owner = input.owner || meta?.owner || '';
      const repo = input.repo || meta?.repo || '';
      const prNumber = input.prNumber || meta?.number || 0;

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
      const ranked = [...highConfidence].sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          b.confidence - a.confidence,
      );
      const kept = ranked.slice(0, LIMITS.maxFindings);
      const droppedOverCap = ranked.length - kept.length;

      const comments = kept.map((f) => {
        let commentBody = `### [${f.severity.toUpperCase()}] ${f.title}\n\n${f.body}`;
        if (f.suggestion) {
          commentBody += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
        }
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
        droppedOverCap > 0 ? `capped ${droppedOverCap} over-limit` : null,
      ]
        .filter(Boolean)
        .join(', ');

      return `Successfully recorded ${comments.length} review findings and summary.${droppedNotes ? ` (${droppedNotes})` : ''}`;
    },
  });
}
