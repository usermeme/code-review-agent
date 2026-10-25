import type {
  GitAdapterContract,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import { type BaseLlm, type Event, InMemoryRunner } from '@google/adk';
import { z } from 'zod';

import {
  createOrchestrator,
  ORCHESTRATOR_AGENT_NAME,
  type OrchestratorTools,
  SubAgentFailedError,
} from './agents/orchestrator.agent.js';
import { ContextError } from './constants/errors.constant.js';
import { LIMITS } from './constants/limits.constant.js';
import { STATE } from './constants/state-keys.constant.js';
import { CoordinateGuardPlugin } from './plugins/coordinate-guard.plugin.js';
import {
  priorFindingSchema,
  type ReviewReport,
  reviewReportSchema,
} from './schemas/review.schema.js';
import { createFetchRepositoryFileTool } from './tools/fetch-repository-file.tool.js';
import { createGetRepoGuidelinesTool } from './tools/get-repo-guidelines.tool.js';
import { createLoadRepoSkillTool } from './tools/load-repo-skill.tool.js';
import { createSearchRepositoryCodeTool } from './tools/search-repository-code.tool.js';
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
import {
  buildPublishTarget,
  finalizeReview,
} from './utils/finalize-review.util.js';

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
  priorFindings: z.array(priorFindingSchema).optional().default([]),
});

export type ReviewExecutionInput = z.input<typeof reviewInputSchema>;

type ParsedReviewInput = z.infer<typeof reviewInputSchema>;
type ParsedPrMeta = ParsedReviewInput['prMeta'];

export interface RunReviewOptions {
  llm: BaseLlm;
  baselineContext?: string | Record<string, string>;
  gitAdapter?: GitAdapterContract;
  /**
   * Called exactly once with the finalized payload, right before runReview
   * returns it. The library itself never publishes — delivering the review
   * (e.g. to Pub/Sub) exactly once is the host's job.
   */
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
}

function buildReviewTools({
  options,
  meta,
  fileCache,
}: BuildReviewToolsArgs): OrchestratorTools {
  return {
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
}

function buildRunTriggerMessage(meta: ParsedPrMeta): string {
  return (
    `Review pull request ${meta.provider || 'github'}:${meta.owner || ''}/` +
    `${meta.repo}#${meta.number} "${meta.title}". ` +
    `The PR metadata, diff, changed-file paths, prior findings, and repository baseline context are in session state.`
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

/** Collects candidate JSON substrings from a raw model text turn. */
function collectReportCandidates(trimmed: string): string[] {
  const candidates: string[] = [];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  candidates.push(fenced ? fenced[1] : trimmed);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  return candidates;
}

/** Parses a model text turn into the final report, tolerating code fences. */
function parseReviewReportText(raw: string): ReviewReport | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const candidate of collectReportCandidates(trimmed)) {
    try {
      const parsed = reviewReportSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON — try the next candidate shape.
    }
  }
  return null;
}

/** Extracts the orchestrator's final report from one of its text events. */
function extractReviewReport(event: Event): ReviewReport | null {
  if (event.author !== ORCHESTRATOR_AGENT_NAME) return null;
  const text = (event.content?.parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
  return parseReviewReportText(text);
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
    `Code review agent finished without a parseable final report for ${args.defaultRepo}#${args.prNumber}.`,
  );
}

/**
 * Runs the full PR review.
 *
 * Failures are loud: agent error events or a run that ends without a
 * parseable final report throw, instead of silently publishing a misleading
 * "no findings" review. The orchestrator delivers the review as its final
 * structured answer (there is no publish tool); this function applies the
 * code-enforced guardrails to it and returns the payload for the host to
 * publish exactly once. All bulk data (diff, PR meta, baseline context
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

  const fileCache = new Map<string, string>();

  const tools = buildReviewTools({ options, meta, fileCache });

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
  const reviewDiff = stripUnreviewableOmissions(prepareDiff(parsed.diff).diff);

  const errors: string[] = [];
  // The orchestrator's final report, locked in as soon as it is emitted while
  // no sub-agent is failed — the same window in which the old publish tool
  // call used to lock in the result. Failures recorded afterwards do not
  // invalidate it; failures recorded before prevent it (the report stays null
  // and resolveRunFailure raises SubAgentFailedError instead). Boxed in an
  // object because TS narrows a closure-assigned `let` back to `null` at the
  // read site below, which would type the report as `never`.
  const locked: { report: ReviewReport | null } = { report: null };
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
        [STATE.diff]: reviewDiff,
        [STATE.changedFiles]: filteredChangedFiles,
        [STATE.priorFindings]: parsed.priorFindings,
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
      if (!locked.report && !failedSubAgents) {
        locked.report = extractReviewReport(event);
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

  // A report locked in before a late failure is still a complete review.
  if (locked.report) {
    const finalized = finalizeReview({
      summary: locked.report.summary,
      findings: locked.report.findings,
      diff: reviewDiff,
      priorFindings: parsed.priorFindings,
      target: buildPublishTarget(meta),
    });
    if (options.onPublishResult) {
      await options.onPublishResult(finalized.payload);
    }
    return finalized.payload;
  }
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
