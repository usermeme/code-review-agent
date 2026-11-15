import type { RepoWorkspace } from '@code-review-agent/agent-tools';
import {
  type AgentModels,
  emptyTokenUsage,
  sumTokenUsage,
} from '@code-review-agent/llm';
import type {
  PriorFinding,
  PRMeta,
  ReviewMetrics,
  ReviewRoute,
} from '@code-review-agent/shared-types';

import {
  buildSummaryOnlyResult,
  type ReviewAgentResult,
  runCodeReview,
} from '../review-agent.js';
import {
  DEFAULT_DEEP_REVIEW_PATHS,
  evaluateDeepReviewPaths,
  evaluateSkipRules,
} from './review-rules.js';
import { TIER_PROFILES } from './tier-profiles.js';
import { runTriage, type TriageResult } from './triage.js';

/** Hard cap on the triage call, whatever the overall budget. */
const MAX_TRIAGE_TIMEOUT_MS = 30_000;
/** A light review that fails is retried as deep only with this much time left. */
const MIN_ESCALATION_BUDGET_MS = 60_000;

export interface ReviewPipelineInput {
  prMeta: PRMeta;
  /** Workspace holding only the PR diff; enough for rules and triage. */
  diffWorkspace: RepoWorkspace;
  /** Loads the full workspace (repo tarball); called only when a review runs. */
  loadWorkspace: () => Promise<RepoWorkspace>;
  priorFindings?: PriorFinding[];
}

export interface ReviewPipelineOptions {
  models: AgentModels;
  /** Wall-clock budget for the whole pipeline (triage + reviews). */
  timeoutMs: number;
  deepReviewPaths?: string[];
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ReviewPipelineResult {
  /** What to publish to the PR, or `null` when the PR was skipped silently. */
  publish: ReviewAgentResult | null;
  metrics: ReviewMetrics;
}

interface PipelineContext {
  input: ReviewPipelineInput;
  options: ReviewPipelineOptions;
  priorFindings: PriorFinding[];
  remainingMs: () => number;
}

function createContext(
  input: ReviewPipelineInput,
  options: ReviewPipelineOptions,
): PipelineContext {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  return {
    input,
    options,
    priorFindings: input.priorFindings ?? [],
    remainingMs: () => deadline - now(),
  };
}

function withRouteNote(
  result: ReviewAgentResult,
  route: ReviewRoute,
): ReviewAgentResult {
  if (result.reviewResult.failure) return result;
  const note = `<sub>Review depth: ${route.tier}. ${route.reason}</sub>`;
  const summary = `${result.reviewResult.summary ?? ''}\n\n${note}`.trim();
  return { ...result, reviewResult: { ...result.reviewResult, summary } };
}

async function runTier(
  ctx: PipelineContext,
  workspace: RepoWorkspace,
  tier: 'light' | 'deep',
  focusFiles: string[],
): Promise<ReviewAgentResult> {
  const { prMeta } = ctx.input;
  return runCodeReview(
    { prMeta, workspace, priorFindings: ctx.priorFindings, focusFiles },
    {
      model: ctx.options.models.reviewer,
      timeoutMs: Math.max(1, ctx.remainingMs()),
      ...TIER_PROFILES[tier],
    },
  );
}

function shouldEscalate(
  ctx: PipelineContext,
  tier: 'light' | 'deep',
  result: ReviewAgentResult,
): boolean {
  return (
    tier === 'light' &&
    Boolean(result.reviewResult.failure) &&
    ctx.remainingMs() >= MIN_ESCALATION_BUDGET_MS
  );
}

/** Runs the chosen tier; a failed light review is retried once as deep. */
async function review(
  ctx: PipelineContext,
  route: ReviewRoute,
  focusFiles: string[],
): Promise<{ result: ReviewAgentResult; route: ReviewRoute }> {
  const tier = route.tier === 'light' ? 'light' : 'deep';
  const workspace = await ctx.input.loadWorkspace();
  const first = await runTier(ctx, workspace, tier, focusFiles);
  if (!shouldEscalate(ctx, tier, first)) return { result: first, route };

  const second = await runTier(ctx, workspace, 'deep', focusFiles);
  const escalated: ReviewRoute = {
    ...route,
    tier: 'deep',
    reason: `${route.reason} Escalated after the light review failed.`,
  };
  return {
    result: { ...second, usage: sumTokenUsage(first.usage, second.usage) },
    route: escalated,
  };
}

async function triage(ctx: PipelineContext): Promise<TriageResult> {
  const { prMeta, diffWorkspace } = ctx.input;
  // Triage may use at most a quarter of what is left, so the review keeps
  // most of the budget even when the overall timeout is short.
  const timeoutMs = Math.min(
    MAX_TRIAGE_TIMEOUT_MS,
    Math.floor(ctx.remainingMs() / 4),
  );
  const result = await runTriage(
    ctx.options.models.triage,
    { prMeta, workspace: diffWorkspace },
    timeoutMs,
  );
  // An explicit `/review` request is never skipped by the model's judgement.
  if (result.route.tier === 'skip' && prMeta.action === 'manual_trigger') {
    return { ...result, route: { ...result.route, tier: 'light' } };
  }
  return result;
}

function skipByTriage(
  ctx: PipelineContext,
  outcome: TriageResult,
): ReviewPipelineResult {
  const summary = `Skipped a detailed review: ${outcome.route.reason}`;
  return {
    publish: buildSummaryOnlyResult(
      ctx.input.prMeta,
      summary,
      ctx.priorFindings,
    ),
    metrics: { route: outcome.route, usage: { triage: outcome.usage } },
  };
}

async function reviewRouted(
  ctx: PipelineContext,
  routing: TriageResult,
): Promise<ReviewPipelineResult> {
  const { result, route } = await review(
    ctx,
    routing.route,
    routing.focusFiles,
  );
  return {
    publish: withRouteNote(result, route),
    metrics: {
      route,
      usage: { triage: routing.usage, reviewer: result.usage },
    },
  };
}

async function routeAndReview(
  ctx: PipelineContext,
  changedFiles: string[],
): Promise<ReviewPipelineResult> {
  const forced = evaluateDeepReviewPaths(
    changedFiles,
    ctx.options.deepReviewPaths ?? DEFAULT_DEEP_REVIEW_PATHS,
  );
  if (forced) {
    return reviewRouted(ctx, {
      route: forced,
      focusFiles: [],
      usage: emptyTokenUsage(),
    });
  }
  const outcome = await triage(ctx);
  if (outcome.route.tier === 'skip') return skipByTriage(ctx, outcome);
  return reviewRouted(ctx, outcome);
}

/**
 * Routes a PR to the cheapest review that fits it:
 * free rules → (deep-path rule | triage model) → reviewer at the chosen depth.
 * Every model-backed step fails open towards a full review.
 */
export async function runReviewPipeline(
  input: ReviewPipelineInput,
  options: ReviewPipelineOptions,
): Promise<ReviewPipelineResult> {
  const ctx = createContext(input, options);
  const { changedFiles } = input.diffWorkspace.getPrDiff({ maxChars: 0 });

  if (changedFiles.length === 0) {
    return {
      publish: buildSummaryOnlyResult(
        input.prMeta,
        'No reviewable code changes in this pull request.',
        ctx.priorFindings,
      ),
      metrics: {
        route: {
          tier: 'skip',
          reason: 'No reviewable code changes.',
          source: 'rule',
        },
        usage: {},
      },
    };
  }

  const skipRoute = evaluateSkipRules(input.prMeta, changedFiles);
  if (skipRoute)
    return { publish: null, metrics: { route: skipRoute, usage: {} } };

  return routeAndReview(ctx, changedFiles);
}
