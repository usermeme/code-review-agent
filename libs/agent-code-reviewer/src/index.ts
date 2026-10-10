import { InMemoryRunner } from '@google/adk';
import {
  createOrchestrator,
  type OrchestratorTools,
} from './agents/orchestrator.agent.js';
import {
  createGetRepoContextTool,
  type ContextLoader,
} from './tools/get-repo-context.tool.js';
import { createPublishReviewResultsTool } from './tools/publish-review-results.tool.js';
import {
  createGetDiscussionTool,
  type DiscussionSearchFunction,
} from './tools/get-discussion.tool.js';
import {
  createStoreDiscussionTool,
  type DiscussionStoreFunction,
} from './tools/store-discussion.tool.js';
import { envService } from './env.js';
import type { ReviewResultPayload } from 'shared-types';

export * from './constants/state-keys.constant.js';
export * from './tools/get-repo-context.tool.js';
export * from './tools/publish-review-results.tool.js';
export * from './tools/get-discussion.tool.js';
export * from './tools/store-discussion.tool.js';
export * from './agents/orchestrator.agent.js';
export * from './agents/problems.agent.js';
export * from './agents/quality.agent.js';
export * from './agents/ticket.agent.js';
export * from './schemas/review.schema.js';
export * from './skills/review.skill.js';
export * from './env.js';

export interface RunReviewOptions {
  model?: string;
  baselineContext?: string | Record<string, string>;
  contextLoader?: ContextLoader;
  searchDiscussions?: DiscussionSearchFunction;
  storeDiscussion?: DiscussionStoreFunction;
  onPublishResult?: (payload: ReviewResultPayload) => Promise<void> | void;
}

export interface ReviewExecutionInput {
  prMeta: {
    provider?: string;
    owner?: string;
    repo: string;
    number: number;
    title: string;
    author: string;
    branch: string;
    body?: string;
  };
  diff: string;
  changedFiles?: string;
  tickets?: any[];
}

export async function runReview(
  input: ReviewExecutionInput,
  options: RunReviewOptions = {},
): Promise<ReviewResultPayload> {
  const model = options.model ?? envService.get('REVIEW_MODEL');
  let resultPayload: ReviewResultPayload | null = null;

  const tools: OrchestratorTools = {
    getRepoContext: createGetRepoContextTool({
      contextLoader: options.contextLoader,
    }),
    publishReviewResults: createPublishReviewResultsTool({
      onPublishResult: async (res) => {
        resultPayload = res;
        if (options.onPublishResult) {
          await options.onPublishResult(res);
        }
      },
    }),
    getDiscussion: createGetDiscussionTool({
      searchDiscussions: options.searchDiscussions,
      defaultRepo: `${input.prMeta.owner}/${input.prMeta.repo}`,
    }),
    storeDiscussion: createStoreDiscussionTool({
      storeDiscussion: options.storeDiscussion,
      defaultRepo: `${input.prMeta.owner}/${input.prMeta.repo}`,
      defaultPrNumber: input.prMeta.number,
    }),
  };

  const agent = createOrchestrator({
    model,
    tools,
  });

  const runner = new InMemoryRunner({ agent });
  for await (const event of runner.runEphemeral({
    userId: 'core-reviewer',
    newMessage: {
      parts: [{ text: JSON.stringify(input) }],
    },
    stateDelta: {
      baselineContext:
        typeof options.baselineContext === 'object'
          ? JSON.stringify(options.baselineContext)
          : options.baselineContext,
    },
  })) {
    void event;
  }

  if (!resultPayload) {
    resultPayload = {
      provider: input.prMeta.provider || 'github',
      owner: input.prMeta.owner || '',
      repo: input.prMeta.repo,
      prNumber: input.prMeta.number,
      summary: 'Code review completed with no automated findings generated.',
      comments: [],
    };
  }

  return resultPayload;
}
