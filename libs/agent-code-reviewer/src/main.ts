import type {
  GitAdapterContract,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import { type BaseLlm, type Event, InMemoryRunner } from '@google/adk';
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
  type LlmCallBudget,
  ReviewBudgetExceededError,
  ReviewTimeoutError,
} from './utils/budget.util.js';
import {
  isIgnoredDiffPath,
  prepareDiff,
  stripUnreviewableOmissions,
} from './utils/diff.util.js';

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

type ParsedReviewInput = z.infer<typeof reviewInputSchema>;
type ParsedPrMeta = ParsedReviewInput['prMeta'];

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

/** True when `parsed` is a plain JSON object usable as named baseline sections. */
function isSectionRecord(parsed: unknown): parsed is Record<string, string> {
  return (
    Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
  );
}

function parseBaselineJson(trimmed: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isSectionRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Not JSON — treat the whole string as the architecture section.
  }
  return null;
}

/** Parses the persisted baseline context into its named sections. */
export function parseBaselineSections(
  baselineContext: string | Record<string, string> | undefined,
): Record<string, string> {
  if (!baselineContext) return {};
  if (typeof baselineContext === 'object') return baselineContext;
  const trimmed = baselineContext.trim();
  if (!trimmed) return {};
  return parseBaselineJson(trimmed) ?? { architecture: trimmed };
}

function parseReviewInput(input: ReviewExecutionInput): ParsedReviewInput {
  try {
    return reviewInputSchema.parse(input);
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
}

function buildDefaultRepo(meta: ParsedPrMeta): string {
  return `${meta.owner || ''}/${meta.repo}`.replace(/^\//, '');
}

interface BuildReviewToolsArgs {
  options: RunReviewOptions;
  meta: ParsedPrMeta;
  fileCache: Map<string, string>;
  defaultRepo: string;
  onPublishResult: (payload: ReviewResultPayload) => Promise<void>;
}

function buildReviewTools({
  options,
  meta,
  fileCache,
  defaultRepo,
  onPublishResult,
}: BuildReviewToolsArgs): OrchestratorTools {
  const tools: OrchestratorTools = {
    publishReviewResults: createPublishReviewResultsTool({
      onPublishResult,
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
      cache: fileCache,
    }),
    getRepoGuidelines: createGetRepoGuidelinesTool({
      gitAdapter: options.gitAdapter,
      defaultOwner: meta.owner,
      defaultRepo: meta.repo,
      cache: fileCache,
    }),
    loadRepoSkill: createLoadRepoSkillTool({
      gitAdapter: options.gitAdapter,
      defaultOwner: meta.owner,
      defaultRepo: meta.repo,
      cache: fileCache,
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

  return tools;
}

function buildRunTriggerMessage(meta: ParsedPrMeta): string {
  return (
    `Review pull request ${meta.provider || 'github'}:${meta.owner || ''}/` +
    `${meta.repo}#${meta.number} "${meta.title}". ` +
    `The PR metadata, diff, changed-file paths, tickets, and repository baseline context are in session state.`
  );
}

function buildContextSectionsState(sections: Record<string, string>) {
  const requiredSection = (key: string) =>
    sections[key] || ContextError.REPO_CONTEXT_NOT_LOADED;
  return {
    [STATE.ctxArchitecture]: requiredSection('architecture'),
    [STATE.ctxModules]: requiredSection('modules'),
    [STATE.ctxPatterns]: requiredSection('patterns'),
    [STATE.ctxErrorHandling]: requiredSection('errorHandling'),
    [STATE.ctxAgentDocs]: sections['agentDocs'] || '',
  };
}

function isAgentErrorEvent(event: Event): boolean {
  return Boolean(event.errorCode || event.errorMessage);
}

function describeAgentErrorEvent(event: Event): string {
  return `${event.errorCode ?? 'agent_error'}: ${event.errorMessage ?? 'unknown error'}`;
}

function resolveRunFailure(args: {
  timedOut: boolean;
  timeoutMs: number;
  budget: LlmCallBudget;
  maxLlmCalls: number;
  failedSubAgents: string[] | undefined;
  errors: string[];
  defaultRepo: string;
  prNumber: number;
}): never {
  // Budget and timeout overruns surface as generic ADK error events; report
  // them as the non-retryable failures they are, so they are not redelivered.
  if (args.timedOut) throw new ReviewTimeoutError(args.timeoutMs);
  if (args.budget.exceeded()) {
    throw new ReviewBudgetExceededError(
      `Review exceeded its budget of ${args.maxLlmCalls} LLM calls.`,
    );
  }
  if (args.failedSubAgents) throw new SubAgentFailedError(args.failedSubAgents);
  if (args.errors.length > 0) {
    throw new Error(`Code review agent failed: ${args.errors.join('; ')}`);
  }
  throw new Error(
    `Code review agent finished without publishing a result (publishReviewResults was never called) for ${args.defaultRepo}#${args.prNumber}.`,
  );
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
  const parsed = parseReviewInput(input);
  const meta = parsed.prMeta;
  const sections = parseBaselineSections(options.baselineContext);
  const defaultRepo = buildDefaultRepo(meta);

  let resultPayload: ReviewResultPayload | null = null;
  const fileCache = new Map<string, string>();

  const tools = buildReviewTools({
    options,
    meta,
    fileCache,
    defaultRepo,
    onPublishResult: async (res) => {
      resultPayload = res;
      if (options.onPublishResult) {
        await options.onPublishResult(res);
      }
    },
  });

  const maxLlmCalls = options.maxLlmCalls ?? LIMITS.maxLlmCalls;
  const timeoutMs = options.timeoutMs ?? LIMITS.reviewTimeoutMs;
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);
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

  const filteredChangedFiles = parsed.changedFiles
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isIgnoredDiffPath(line))
    .join('\n');

  const errors: string[] = [];
  const consume = async () => {
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: {
        parts: [
          {
            text: buildRunTriggerMessage(meta),
          },
        ],
      },
      stateDelta: {
        [STATE.prMeta]: meta,
        [STATE.diff]: stripUnreviewableOmissions(prepareDiff(parsed.diff).diff),
        [STATE.changedFiles]: filteredChangedFiles,
        [STATE.tickets]: parsed.tickets,
        ...buildContextSectionsState(sections),
      },
      runConfig: { maxLlmCalls },
      abortSignal: abort.signal,
    })) {
      if (isAgentErrorEvent(event)) {
        errors.push(describeAgentErrorEvent(event));
        // Stop consuming immediately: in @google/adk, an error yielded from a
        // beforeToolCallback leaves stepHadToolCalls=true with an empty-content
        // error event, which prevents LlmAgent.runAsyncImpl from exiting its
        // loop and would otherwise burn remaining maxLlmCalls.
        break;
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
    abort.abort();
    await runner.sessionService.deleteSession({
      appName: runner.appName,
      userId,
      sessionId: session.id,
    });
  }

  // A result published before a late failure is still a complete review.
  if (resultPayload) return resultPayload;
  resolveRunFailure({
    timedOut,
    timeoutMs,
    budget,
    maxLlmCalls,
    failedSubAgents,
    errors,
    defaultRepo,
    prNumber: meta.number,
  });
}
