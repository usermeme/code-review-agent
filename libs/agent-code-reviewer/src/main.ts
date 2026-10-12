import { type BaseLlm, InMemoryRunner } from '@google/adk';
import type { GitAdapterContract, ReviewResultPayload } from 'shared-types';

import {
  createOrchestrator,
  type OrchestratorTools,
} from './agents/orchestrator.agent.js';
import { createFetchRepositoryFileTool } from './tools/fetch-repository-file.tool.js';
import {
  createGetDiscussionTool,
  type DiscussionSearchFunction,
} from './tools/get-discussion.tool.js';
import {
  type ContextLoader,
  createGetRepoContextTool,
} from './tools/get-repo-context.tool.js';
import { createGetRepoGuidelinesTool } from './tools/get-repo-guidelines.tool.js';
import { createPublishReviewResultsTool } from './tools/publish-review-results.tool.js';
import { createSearchRepositoryCodeTool } from './tools/search-repository-code.tool.js';
import {
  createStoreDiscussionTool,
  type DiscussionStoreFunction,
} from './tools/store-discussion.tool.js';

export interface RunReviewOptions {
  llm: BaseLlm;
  baselineContext?: string | Record<string, string>;
  contextLoader?: ContextLoader;
  gitAdapter?: GitAdapterContract;
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
  tickets?: unknown[];
}

export async function runReview(
  input: ReviewExecutionInput,
  options: RunReviewOptions,
): Promise<ReviewResultPayload> {
  const llm = options.llm;
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
    searchRepositoryCode: createSearchRepositoryCodeTool({
      gitAdapter: options.gitAdapter,
      defaultOwner: input.prMeta.owner,
      defaultRepo: input.prMeta.repo,
    }),
    fetchRepositoryFile: createFetchRepositoryFileTool({
      gitAdapter: options.gitAdapter,
      defaultOwner: input.prMeta.owner,
      defaultRepo: input.prMeta.repo,
    }),
    getRepoGuidelines: createGetRepoGuidelinesTool({
      gitAdapter: options.gitAdapter,
      defaultOwner: input.prMeta.owner,
      defaultRepo: input.prMeta.repo,
    }),
  };

  const agent = createOrchestrator({
    llm,
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
