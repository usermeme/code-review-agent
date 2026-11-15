import type { PriorFinding } from '@code-review-agent/shared-types';

import type { ReviewAgentResult } from '../review-agent.js';
import {
  toPriorFinding,
  toReviewCommentPayload,
} from '../schemas/review-output.schema.js';
import type { AnchoredFinding } from '../tools/submit-review.tool.js';

/** Rebuilds a review result's comments and persisted findings from `findings`. */
export function withFindings(
  result: ReviewAgentResult,
  findings: AnchoredFinding[],
  priorFindings: PriorFinding[],
  summary = result.reviewResult.summary,
): ReviewAgentResult {
  return {
    ...result,
    findings,
    reviewResult: {
      ...result.reviewResult,
      summary,
      comments: findings.map((f) =>
        toReviewCommentPayload(f.finding, f.anchor),
      ),
    },
    publishedFindings: [
      ...priorFindings,
      ...findings.map((f) => toPriorFinding(f.finding, f.anchor)),
    ],
  };
}
