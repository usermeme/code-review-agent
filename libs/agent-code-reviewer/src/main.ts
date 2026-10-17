import type {
  GitAdapterContract,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import { type BaseLlm, InMemoryRunner } from '@google/adk';
import { z } from 'zod';

import {
  createOrchestrator,
  type OrchestratorTools,
} from './agents/orchestrator.agent.js';
import { ContextError } from './constants/errors.constant.js';
import { LIMITS } from './constants/limits.constant.js';
import { STATE } from './constants/state-keys.constant.js';
import { CoordinateGuardPlugin } from './plugins/coordinate-guard.plugin.js';
import { createFetchRepositoryFileTool } from './tools/fetch-repository-file.tool.js';
import {
  createGetDiscussionTool,
  type DiscussionSearchFunction,
} from './tools/get-discussion.tool.js';
import { createGetRepoGuidelinesTool } from './tools/get-repo-guidelines.tool.js';
import { createPublishReviewResultsTool } from './tools/publish-review-results.tool.js';
import { createSearchRepositoryCodeTool } from './tools/search-repository-code.tool.js';
import {
  createStoreDiscussionTool,
  type DiscussionStoreFunction,
} from './tools/store-discussion.tool.js';

/**
 * Validated review input. Parsing happens in code (fail-fast) — the payload
 * is seeded into session state via `stateDelta`, never re-parsed from the
 * user message inside an instruction callback.
 */
export const reviewInputSchema = z.object({
  prMeta: z.object({
    provider: z.string().optional().default('github'),
    owner: z.string().optional().default(''),
    repo: z.string(),
    number: z.number(),
    title: z.string(),
    author: z.string(),
    branch: z.string(),
    body: z.string().optional(),
    baseRef: z.string().optional(),
    headSha: z.string().optional(),
  }),
  diff: z.string(),
  changedFiles: z.string().optional().default(''),
  tickets: z.array(z.unknown()).optional().default([]),
});

export type ReviewExecutionInput = z.input<typeof reviewInputSchema>;

export interface RunReviewOptions {
  llm: BaseLlm;
  baselineContext?: string | Record<string, string>;
  gitAdapter?: GitAdapterContract;
  searchDiscussions?: DiscussionSearchFunction;
  storeDiscussion?: DiscussionStoreFunction;
  onPublishResult?: (payload: ReviewResultPayload) => Promise<void> | void;
}

/** Parses the persisted baseline context into its named sections. */
export function parseBaselineSections(
  baselineContext: string | Record<string, string> | undefined,
): Record<string, string> {
  if (!baselineContext) return {};
  if (typeof baselineContext === 'object') return baselineContext;
  const trimmed = baselineContext.trim();
  if (!trimmed || trimmed === '{}') return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Not JSON — treat the whole string as the architecture section.
  }
  return { architecture: trimmed };
}

/**
 * Runs the full PR review.
 *
 * Failures are loud: agent error events or a run that ends without calling
 * publishReviewResults throw, instead of silently publishing a misleading
 * "no findings" review. All bulk data (diff, PR meta, baseline context
 * sections) is seeded through `stateDelta` — the user message is a short
 * trigger line and no dependency object is ever serialized into model input.
 */
export async function runReview(
  input: ReviewExecutionInput,
  options: RunReviewOptions,
): Promise<ReviewResultPayload> {
  const parsed = reviewInputSchema.parse(input);
  const meta = parsed.prMeta;
  const sections = parseBaselineSections(options.baselineContext);
  const defaultRepo = `${meta.owner || ''}/${meta.repo}`.replace(/^\//, '');

  let resultPayload: ReviewResultPayload | null = null;

  const tools: OrchestratorTools = {
    publishReviewResults: createPublishReviewResultsTool({
      onPublishResult: async (res) => {
        resultPayload = res;
        if (options.onPublishResult) {
          await options.onPublishResult(res);
        }
      },
    }),
    searchRepositoryCode: createSearchRepositoryCodeTool({
      gitAdapter: options.gitAdapter,
      defaultOwner: meta.owner,
      defaultRepo: meta.repo,
    }),
    fetchRepositoryFile: createFetchRepositoryFileTool({
      gitAdapter: options.gitAdapter,
      defaultOwner: meta.owner,
      defaultRepo: meta.repo,
    }),
    getRepoGuidelines: createGetRepoGuidelinesTool({
      gitAdapter: options.gitAdapter,
      defaultOwner: meta.owner,
      defaultRepo: meta.repo,
    }),
  };

  // Discussion tools are registered only when the host actually wired a
  // store — otherwise the model would waste turns on permanent no-ops.
  if (options.searchDiscussions) {
    tools.getDiscussion = createGetDiscussionTool({
      searchDiscussions: options.searchDiscussions,
      defaultRepo,
    });
  }
  if (options.storeDiscussion) {
    tools.storeDiscussion = createStoreDiscussionTool({
      storeDiscussion: options.storeDiscussion,
      defaultRepo,
      defaultPrNumber: meta.number,
    });
  }

  const agent = createOrchestrator({ llm: options.llm, tools });
  const runner = new InMemoryRunner({
    agent,
    plugins: [new CoordinateGuardPlugin()],
  });

  const errors: string[] = [];
  for await (const event of runner.runEphemeral({
    userId: 'core-reviewer',
    newMessage: {
      parts: [
        {
          text:
            `Review pull request ${meta.provider || 'github'}:${meta.owner || ''}/` +
            `${meta.repo}#${meta.number} "${meta.title}". ` +
            `The PR metadata, diff, changed-file paths, tickets, and repository baseline context are in session state.`,
        },
      ],
    },
    stateDelta: {
      [STATE.prMeta]: meta,
      [STATE.diff]: parsed.diff,
      [STATE.changedFiles]: parsed.changedFiles,
      [STATE.tickets]: parsed.tickets,
      [STATE.ctxArchitecture]:
        sections['architecture'] || ContextError.REPO_CONTEXT_NOT_LOADED,
      [STATE.ctxModules]:
        sections['modules'] || ContextError.REPO_CONTEXT_NOT_LOADED,
      [STATE.ctxPatterns]:
        sections['patterns'] || ContextError.REPO_CONTEXT_NOT_LOADED,
      [STATE.ctxErrorHandling]:
        sections['errorHandling'] || ContextError.REPO_CONTEXT_NOT_LOADED,
      [STATE.ctxAgentDocs]: sections['agentDocs'] || '',
    },
    runConfig: { maxLlmCalls: LIMITS.maxLlmCalls },
  })) {
    if (event.errorCode || event.errorMessage) {
      errors.push(
        `${event.errorCode ?? 'agent_error'}: ${event.errorMessage ?? 'unknown error'}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Code review agent failed: ${errors.join('; ')}`);
  }
  if (!resultPayload) {
    throw new Error(
      `Code review agent finished without publishing a result (publishReviewResults was never called) for ${defaultRepo}#${meta.number}.`,
    );
  }

  return resultPayload;
}
