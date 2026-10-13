import type {
  AgentDoc,
  GitAdapterContract,
  RepoContextContent,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import { type BaseLlm, InMemoryRunner } from '@google/adk';

import { createOrchestrator } from './agents/orchestrator.agent.js';
import { ContextError } from './constants/errors.constant.js';
import { type PrMeta, STATE } from './constants/state-keys.constant.js';
import { toReviewResultPayload } from './review-result.js';
import type { ReviewPlan } from './schemas/review.schema.js';
import { createFetchRepositoryFileTool } from './tools/fetch-repository-file.tool.js';
import {
  createGetDiscussionTool,
  type DiscussionSearchFunction,
} from './tools/get-discussion.tool.js';
import { createGetRepoGuidelinesTool } from './tools/get-repo-guidelines.tool.js';
import type { RepoScope } from './tools/repo-scope.js';
import { createSearchRepositoryCodeTool } from './tools/search-repository-code.tool.js';
import {
  createStoreDiscussionTool,
  type DiscussionStoreFunction,
} from './tools/store-discussion.tool.js';
import { createSubmitReviewTool } from './tools/submit-review.tool.js';

/** Collaborators. Kept apart from the input so nothing here can end up in a prompt. */
export interface ReviewerDeps {
  llm: BaseLlm;
  gitAdapter: GitAdapterContract;
  searchDiscussions?: DiscussionSearchFunction;
  storeDiscussion?: DiscussionStoreFunction;
}

export interface ReviewExecutionInput {
  prMeta: PrMeta;
  diff: string;
  changedFiles?: string;
  tickets?: unknown[];
  /** The repo's baseline context; reviews still run without one, less informed. */
  context: RepoContextContent | null;
}

export class ReviewNotSubmittedError extends Error {
  constructor(prKey: string) {
    super(
      `Reviewer finished without submitting a review for ${prKey}; nothing was posted.`,
    );
    this.name = 'ReviewNotSubmittedError';
  }
}

/**
 * Reviews one PR. Everything the agents read (PR metadata, diff, repo
 * context) is seeded into session state from code. The orchestrator decides
 * which sub-agents and tools to use, and hands its result back through
 * submit_review.
 */
export async function runReview(
  input: ReviewExecutionInput,
  deps: ReviewerDeps,
): Promise<ReviewResultPayload> {
  const { prMeta } = input;
  const scope: RepoScope = {
    gitAdapter: deps.gitAdapter,
    owner: prMeta.owner,
    repo: prMeta.repo,
    headRef: prMeta.branch,
    baseRef: prMeta.baseRef,
  };
  const repoName = `${prMeta.owner}/${prMeta.repo}`;

  let plan: ReviewPlan | null = null;
  const agent = createOrchestrator({
    llm: deps.llm,
    tools: {
      submitReview: createSubmitReviewTool((submitted) => {
        plan = submitted;
      }),
      getRepoGuidelines: createGetRepoGuidelinesTool({ scope }),
      searchRepositoryCode: createSearchRepositoryCodeTool({ scope }),
      fetchRepositoryFile: createFetchRepositoryFileTool({ scope }),
      discussion: [
        ...(deps.searchDiscussions
          ? [
              createGetDiscussionTool({
                searchDiscussions: deps.searchDiscussions,
                repo: repoName,
              }),
            ]
          : []),
        ...(deps.storeDiscussion
          ? [
              createStoreDiscussionTool({
                storeDiscussion: deps.storeDiscussion,
                repo: repoName,
                prNumber: prMeta.number,
              }),
            ]
          : []),
      ],
    },
  });

  const runner = new InMemoryRunner({ agent });
  for await (const event of runner.runEphemeral({
    userId: 'core-reviewer',
    newMessage: {
      parts: [
        { text: 'Review the pull request described in your instructions.' },
      ],
    },
    stateDelta: seedState(input),
  })) {
    void event;
  }

  const submitted = plan;
  if (!submitted) {
    throw new ReviewNotSubmittedError(`${repoName}#${prMeta.number}`);
  }
  return toReviewResultPayload(submitted, {
    provider: prMeta.provider,
    owner: prMeta.owner,
    repo: prMeta.repo,
    prNumber: prMeta.number,
  });
}

function seedState(input: ReviewExecutionInput): Record<string, unknown> {
  const sections = input.context?.sections;
  const notLoaded = ContextError.REPO_CONTEXT_NOT_LOADED;
  return {
    [STATE.prMeta]: input.prMeta,
    [STATE.diff]: input.diff,
    [STATE.changedFiles]: input.changedFiles ?? '',
    [STATE.tickets]: input.tickets ?? [],
    [STATE.ctxArchitecture]: sections?.architecture ?? notLoaded,
    [STATE.ctxModules]: sections?.modules ?? notLoaded,
    [STATE.ctxPatterns]: sections?.patterns ?? notLoaded,
    [STATE.ctxErrorHandling]: sections?.errorHandling ?? notLoaded,
    [STATE.ctxAgentDocs]: renderAgentDocs(input.context?.agentDocs ?? []),
  };
}

function renderAgentDocs(docs: AgentDoc[]): string {
  return docs
    .map((doc) => `### ${doc.path}\n\n${doc.content}`)
    .join('\n\n---\n\n');
}
