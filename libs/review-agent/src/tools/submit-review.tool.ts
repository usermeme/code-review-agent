import type { RepoWorkspace } from '@code-review-agent/agent-tools';
import type {
  PriorFinding,
  ReviewCommentPayload,
} from '@code-review-agent/shared-types';
import { type Context, FunctionTool } from '@google/adk';

import {
  deduplicateFindings,
  type ReviewFinding,
  type SubmitReviewInput,
  submitReviewSchema,
  toPriorFinding,
  toReviewCommentPayload,
} from '../schemas/review-output.schema.js';

export interface ValidatedReviewSubmission {
  summary: string;
  comments: ReviewCommentPayload[];
  publishedFindings: PriorFinding[];
}

export interface SubmitReviewState {
  getAcceptedSubmission(): ValidatedReviewSubmission | undefined;
  getFallbackDraft(): ValidatedReviewSubmission | undefined;
}

export interface SubmitReviewToolBundle {
  tool: FunctionTool<typeof submitReviewSchema>;
  state: SubmitReviewState;
}

interface PartitionedFindings {
  comments: ReviewCommentPayload[];
  publishedFindings: PriorFinding[];
  errors: string[];
}

function formatAnchorError(finding: ReviewFinding): string {
  const range =
    finding.startLine !== undefined
      ? `${finding.startLine}-${finding.line}`
      : `${finding.line}`;
  return `Finding "${finding.title}" at ${finding.path}:${range} rejected: line is not a valid NEW-side diff line (L<num> |). Check L<num> | prefixes in the diff for ${finding.path}.`;
}

function partitionFindingsByAnchor(
  workspace: RepoWorkspace,
  findings: ReviewFinding[],
): PartitionedFindings {
  const comments: ReviewCommentPayload[] = [];
  const publishedFindings: PriorFinding[] = [];
  const errors: string[] = [];

  for (const finding of findings) {
    const anchor = workspace.resolveCommentAnchor(
      finding.path,
      finding.line,
      finding.startLine,
    );
    if (!anchor) {
      errors.push(formatAnchorError(finding));
      continue;
    }
    comments.push(toReviewCommentPayload(finding, anchor));
    publishedFindings.push(toPriorFinding(finding, anchor));
  }

  return { comments, publishedFindings, errors };
}

function markSkipSummarization(toolContext?: Context): void {
  if (toolContext) {
    toolContext.actions.skipSummarization = true;
  }
}

/**
 * Creates the `submit_review` ADK `FunctionTool` that validates diff anchors
 * against `RepoWorkspace` and allows one self-correction turn if the model
 * references a line outside the diff hunks.
 */
export function createSubmitReviewTool(
  workspace: RepoWorkspace,
  priorFindings: PriorFinding[] = [],
): SubmitReviewToolBundle {
  let acceptedSubmission: ValidatedReviewSubmission | undefined;
  let fallbackDraft: ValidatedReviewSubmission | undefined;
  let rejectionCount = 0;

  const tool = new FunctionTool({
    name: 'submit_review',
    description:
      'Submit the final pull request code review summary and inline findings. Every finding must anchor to a valid 1-based NEW-side line number (L<num> |) in the PR diff.',
    parameters: submitReviewSchema,
    execute: (input: SubmitReviewInput, toolContext?: Context) => {
      const uniqueFindings = deduplicateFindings(input.findings, priorFindings);
      const partitioned = partitionFindingsByAnchor(workspace, uniqueFindings);
      const draft: ValidatedReviewSubmission = {
        summary: input.summary.trim(),
        comments: partitioned.comments,
        publishedFindings: partitioned.publishedFindings,
      };
      fallbackDraft = draft;

      if (partitioned.errors.length > 0 && rejectionCount === 0) {
        rejectionCount += 1;
        return {
          accepted: false,
          validFindingsCount: partitioned.comments.length,
          rejectedFindingsCount: partitioned.errors.length,
          errors: partitioned.errors,
          instruction:
            'Fix the rejected findings by anchoring them to valid L<num> NEW-side line numbers from the diff (or omit findings that cannot be anchored to the diff) and call submit_review again.',
        };
      }

      acceptedSubmission = draft;
      markSkipSummarization(toolContext);
      return {
        accepted: true,
        publishedCommentsCount: partitioned.comments.length,
        droppedFindingsCount: partitioned.errors.length,
      };
    },
  });

  return {
    tool,
    state: {
      getAcceptedSubmission: () => acceptedSubmission,
      getFallbackDraft: () => fallbackDraft,
    },
  };
}
