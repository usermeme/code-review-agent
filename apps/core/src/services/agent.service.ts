import {
  type ReviewExecutionInput,
  runReview,
  type RunReviewOptions,
} from '@code-review-agent/agent-code-reviewer';
import {
  buildContext,
  type BuildContextOptions,
} from '@code-review-agent/agent-context-builder';
import type { ReviewResultPayload } from '@code-review-agent/shared-types';

export class AgentService {
  async buildContext(
    options: BuildContextOptions,
  ): Promise<Record<string, string> | string> {
    return buildContext(options);
  }

  async runReview(
    input: ReviewExecutionInput,
    options: RunReviewOptions,
  ): Promise<ReviewResultPayload> {
    return runReview(input, options);
  }
}
