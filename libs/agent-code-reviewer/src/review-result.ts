import type {
  ReviewCommentPayload,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';

import type { Finding, ReviewPlan } from './schemas/review.schema.js';

export const MIN_FINDING_CONFIDENCE = 0.75;
export const MAX_FINDINGS = 15;

const SEVERITY_RANK: Record<Finding['severity'], number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

export interface ReviewTarget {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Turns the submitted plan into the payload posted to the PR. The confidence
 * floor and the findings cap are enforced here, in code, rather than trusted
 * to the prompt.
 */
export function toReviewResultPayload(
  plan: ReviewPlan,
  target: ReviewTarget,
): ReviewResultPayload {
  const comments = plan.findings
    .filter((f) => f.confidence >= MIN_FINDING_CONFIDENCE)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, MAX_FINDINGS)
    .map(toComment);

  return {
    ...target,
    summary: plan.summary,
    ticketCoverage: plan.ticketCoverage,
    comments,
  };
}

function toComment(finding: Finding): ReviewCommentPayload {
  let body = `### [${finding.severity.toUpperCase()}] ${finding.title}\n\n${finding.body}`;
  if (finding.suggestion) {
    body += `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
  }
  return {
    path: finding.path,
    line: finding.endLine,
    ...(finding.startLine < finding.endLine
      ? { startLine: finding.startLine }
      : {}),
    body,
  };
}
