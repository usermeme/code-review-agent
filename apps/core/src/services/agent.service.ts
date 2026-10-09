import {
  buildContext as defaultBuildContext,
  type BuildContextOptions,
} from 'agent-context-builder';
import {
  runReview as defaultRunReview,
  type ReviewExecutionInput,
  type RunReviewOptions,
} from 'agent-code-reviewer';
import type { ReviewResultPayload } from 'shared-types';

export interface AgentService {
  buildContext(
    options: BuildContextOptions,
  ): Promise<Record<string, string> | string>;
  runReview(
    input: ReviewExecutionInput,
    options?: RunReviewOptions,
  ): Promise<ReviewResultPayload>;
}

export class DefaultAgentService implements AgentService {
  async buildContext(
    options: BuildContextOptions,
  ): Promise<Record<string, string> | string> {
    return defaultBuildContext(options);
  }

  async runReview(
    input: ReviewExecutionInput,
    options?: RunReviewOptions,
  ): Promise<ReviewResultPayload> {
    return defaultRunReview(input, options);
  }
}
