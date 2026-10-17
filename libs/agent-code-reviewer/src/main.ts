import type {
  GitAdapterContract,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import { type BaseLlm, InMemoryRunner } from '@google/adk';

import {
  createOrchestrator,
  type OrchestratorTools,
} from './agents/orchestrator.agent.js';
import { STATE } from './constants/state-keys.constant.js';
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
import {
  createLlmCallBudget,
  ReviewBudgetExceededError,
  ReviewRunError,
  ReviewTimeoutError,
} from './utils/budget.util.js';
import { prepareDiff } from './utils/diff.util.js';

/**
 * Across the orchestrator AND all sub-agents. A normal review needs ~15: about
 * 6 orchestrator turns plus a few turns per sub-agent.
 */
export const DEFAULT_MAX_LLM_CALLS = 40;
/** Kept below the Pub/Sub ack deadline (600s) so a run never outlives its delivery. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 8 * 60_000;

export interface RunReviewOptions {
  llm: BaseLlm;
  baselineContext?: string | Record<string, string>;
  contextLoader?: ContextLoader;
  gitAdapter?: GitAdapterContract;
  searchDiscussions?: DiscussionSearchFunction;
  storeDiscussion?: DiscussionStoreFunction;
  onPublishResult?: (payload: ReviewResultPayload) => Promise<void> | void;
  /** Hard cap on LLM calls for the whole review, sub-agents included. */
  maxLlmCalls?: number;
  /** Hard wall-clock limit; in-flight LLM requests are aborted when it fires. */
  timeoutMs?: number;
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

  const maxLlmCalls = options.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const budget = createLlmCallBudget(maxLlmCalls, abort.signal);

  const agent = createOrchestrator({
    llm,
    tools,
    budget,
  });

  const { diff } = prepareDiff(input.diff);
  const runner = new InMemoryRunner({ agent });
  const userId = 'core-reviewer';
  // runEphemeral does not forward an abort signal, so manage the session here.
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId,
  });

  // ADK does not throw from a run: errors raised in callbacks or model calls
  // end the run with an error event instead, so remember the first one.
  let errorEvent: { code: string; message: string } | undefined;
  const consume = async () => {
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      // The PR input travels via state, not the message: the orchestrator
      // re-sends its whole history on every turn, so a diff in the message
      // would be paid for again on each of them.
      newMessage: {
        parts: [
          {
            text: `Review pull request ${input.prMeta.owner}/${input.prMeta.repo}#${input.prMeta.number}.`,
          },
        ],
      },
      stateDelta: {
        [STATE.prMeta]: input.prMeta,
        [STATE.diff]: diff,
        [STATE.changedFiles]: input.changedFiles ?? '',
        [STATE.tickets]: input.tickets ?? [],
        baselineContext:
          typeof options.baselineContext === 'object'
            ? JSON.stringify(options.baselineContext)
            : options.baselineContext,
      },
      runConfig: { maxLlmCalls },
      abortSignal: abort.signal,
    })) {
      if (event.errorCode && !errorEvent) {
        errorEvent = {
          code: event.errorCode,
          message: event.errorMessage ?? '',
        };
      }
    }
  };
  // Returns at the deadline even if a model call ignores the abort signal.
  const deadline = new Promise<void>((resolve) =>
    abort.signal.addEventListener('abort', () => resolve(), { once: true }),
  );

  try {
    await Promise.race([consume(), deadline]);
  } finally {
    clearTimeout(timer);
    await runner.sessionService.deleteSession({
      appName: runner.appName,
      userId,
      sessionId: session.id,
    });
  }

  // A result published before a late failure is still a complete review.
  if (resultPayload) return resultPayload;
  if (abort.signal.aborted) throw new ReviewTimeoutError(timeoutMs);
  if (budget.exceeded()) {
    throw new ReviewBudgetExceededError(
      `Review exceeded its budget of ${maxLlmCalls} LLM calls.`,
    );
  }
  if (errorEvent) throw new ReviewRunError(errorEvent.code, errorEvent.message);

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
