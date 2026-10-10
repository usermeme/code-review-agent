import { buildContext, type BuildContextOptions } from 'agent-context-builder';
import {
  runReview,
  type ReviewExecutionInput,
  type RunReviewOptions,
} from 'agent-code-reviewer';
import type { ReviewResultPayload } from 'shared-types';

export class AgentService {
  async buildContext(
    options: BuildContextOptions,
  ): Promise<Record<string, string> | string> {
    return buildContext(options);
  }

  async runReview(
    input: ReviewExecutionInput,
    options?: RunReviewOptions,
  ): Promise<ReviewResultPayload> {
    return runReview(input, options);
  }
}
