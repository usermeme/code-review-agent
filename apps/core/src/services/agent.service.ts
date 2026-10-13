import {
  type ReviewExecutionInput,
  runReview,
  type RunReviewOptions,
} from '@code-review-agent/agent-code-reviewer';
import {
  buildRepoContext,
  type BuildRepoContextInput,
  type BuiltRepoContext,
  type ContextBuilderLogger,
} from '@code-review-agent/agent-context-builder';
import type {
  GitAdapterContract,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';

export interface AgentServiceDependencies {
  llm: BaseLlm;
  gitAdapter: GitAdapterContract;
}

/** Runs the agent libraries with core's LLM and git adapter. */
export class AgentService {
  constructor(private readonly deps: AgentServiceDependencies) {}

  async buildRepoContext(
    input: BuildRepoContextInput,
    logger?: ContextBuilderLogger,
  ): Promise<BuiltRepoContext> {
    return buildRepoContext(input, { ...this.deps, logger });
  }

  async runReview(
    input: ReviewExecutionInput,
    options: Omit<RunReviewOptions, 'llm' | 'gitAdapter'>,
  ): Promise<ReviewResultPayload> {
    return runReview(input, { ...options, ...this.deps });
  }
}

/** What the orchestrator needs from the agents; lets tests pass plain fakes. */
export type AgentRunner = Pick<AgentService, 'buildRepoContext' | 'runReview'>;
