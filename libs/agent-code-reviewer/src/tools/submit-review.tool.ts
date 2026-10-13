import { FunctionTool } from '@google/adk';

import { type ReviewPlan, reviewPlanSchema } from '../schemas/review.schema.js';

/**
 * The orchestrator's only way to hand back its result: it submits the plan,
 * and runReview turns it into the payload. Which PR the plan belongs to is
 * fixed in code, never taken from the model.
 */
export function createSubmitReviewTool(onSubmit: (plan: ReviewPlan) => void) {
  return new FunctionTool({
    name: 'submit_review',
    description:
      'Submits the final review: summary, ticket coverage, and the deduplicated high-confidence findings. Call exactly once, at the end.',
    parameters: reviewPlanSchema,
    execute: async (plan) => {
      onSubmit(plan);
      return 'Review submitted.';
    },
  });
}
