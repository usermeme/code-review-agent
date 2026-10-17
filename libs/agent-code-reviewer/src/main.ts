import type {
  GitAdapterContract,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import { type BaseLlm, InMemoryRunner } from '@google/adk';
import { z } from 'zod';

import {
  createOrchestrator,
  type OrchestratorTools,
  SubAgentFailedError,
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
import { createLoadRepoSkillTool } from './tools/load-repo-skill.tool.js';
import { createPublishReviewResultsTool } from './tools/publish-review-results.tool.js';
import { createSearchRepositoryCodeTool } from './tools/search-repository-code.tool.js';
import {
  createStoreDiscussionTool,
  type DiscussionStoreFunction,
} from './tools/store-discussion.tool.js';
import {
  createLlmCallBudget,
  ReviewBudgetExceededError,
  ReviewTimeoutError,
} from './utils/budget.util.js';
import { prepareDiff } from './utils/diff.util.js';

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
  /** Overrides LIMITS.maxLlmCalls (orchestrator and sub-agents combined). */
  maxLlmCalls?: number;
  /** Overrides LIMITS.reviewTimeoutMs; in-flight LLM requests are aborted when it fires. */
  timeoutMs?: number;
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
  let parsed: z.infer<typeof reviewInputSchema>;
  try {
    parsed = reviewInputSchema.parse(input);
  } catch (err) {
    // Malformed input is deterministic — redelivery cannot fix it.
    if (err instanceof z.ZodError) {
      throw new NonRetryableTaskError(
        `Invalid review input: ${err.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    throw err;
  }
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
    loadRepoSkill: createLoadRepoSkillTool({
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

  const maxLlmCalls = options.maxLlmCalls ?? LIMITS.maxLlmCalls;
  const timeoutMs = options.timeoutMs ?? LIMITS.reviewTimeoutMs;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const budget = createLlmCallBudget(maxLlmCalls, abort.signal);

  let failedSubAgents: string[] | undefined;
  const agent = createOrchestrator({
    llm: options.llm,
    tools,
    hasTickets: parsed.tickets.length > 0,
    budget,
    onSubAgentFailure: (agents) => {
      failedSubAgents = agents;
    },
  });
  const runner = new InMemoryRunner({
    agent,
    plugins: [new CoordinateGuardPlugin()],
  });
  const userId = 'core-reviewer';
  // runEphemeral does not forward an abort signal, so manage the session here.
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId,
  });

  const errors: string[] = [];
  const consume = async () => {
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
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
        [STATE.diff]: prepareDiff(parsed.diff).diff,
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
      runConfig: { maxLlmCalls },
      abortSignal: abort.signal,
    })) {
      if (event.errorCode || event.errorMessage) {
        errors.push(
          `${event.errorCode ?? 'agent_error'}: ${event.errorMessage ?? 'unknown error'}`,
        );
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
  // Budget and timeout overruns surface as generic ADK error events; report
  // them as the non-retryable failures they are, so they are not redelivered.
  if (abort.signal.aborted) throw new ReviewTimeoutError(timeoutMs);
  if (budget.exceeded()) {
    throw new ReviewBudgetExceededError(
      `Review exceeded its budget of ${maxLlmCalls} LLM calls.`,
    );
  }
  if (failedSubAgents) throw new SubAgentFailedError(failedSubAgents);
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
