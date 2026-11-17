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
  ReviewThread,
} from '@code-review-agent/shared-types';

import {
  countSelectedRules,
  type ResolvedReviewContext,
  type SelectedRules,
  selectRules,
} from '../context/select-rules.js';
import {
  buildSummaryOnlyResult,
  type ReviewAgentResult,
  runCodeReview,
} from '../review-agent.js';
import { dedupeAgainstThreads } from './dedupe-step.js';
import { withFindings } from './result-findings.js';
import {
  DEFAULT_DEEP_REVIEW_PATHS,
  evaluateDeepReviewPaths,
  evaluateSkipRules,
} from './review-rules.js';
import { TIER_PROFILES } from './tier-profiles.js';
import { runTriage, type TriageResult } from './triage.js';
import { verifyStep } from './verify-step.js';

/** Hard cap on the triage call, whatever the overall budget. */
const MAX_TRIAGE_TIMEOUT_MS = 30_000;
/** A light review that fails is retried as deep only with this much time left. */
const MIN_ESCALATION_BUDGET_MS = 60_000;
/** Hard cap on resolving the review context (cache lookup or a build). */
const MAX_CONTEXT_TIMEOUT_MS = 45_000;

export interface ReviewPipelineInput {
  prMeta: PRMeta;
  /** Workspace holding only the PR diff; enough for rules and triage. */
  diffWorkspace: RepoWorkspace;
  /** Loads the full workspace (repo tarball); called only when a review runs. */
  loadWorkspace: () => Promise<RepoWorkspace>;
  priorFindings?: PriorFinding[];
  /** Inline review threads already on the PR (any author); empty if unknown. */
  reviewThreads?: ReviewThread[];
  /** Set when the diffs hold only the changes since this already-reviewed commit. */
  incrementalSince?: string;
  /**
   * Resolves the repository's review rules (base branch, cached). Runs next
   * to `loadWorkspace`. Without it, prompts carry the raw guidelines.
   */
  loadReviewContext?: (timeoutMs: number) => Promise<ResolvedReviewContext>;
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
  notes: string[],
): ReviewAgentResult {
  if (result.reviewResult.failure) return result;
  const details = [route.reason, ...notes].filter(Boolean).join(' ');
  const note = `<sub>Review depth: ${route.tier}. ${details}</sub>`;
  const summary = `${result.reviewResult.summary ?? ''}\n\n${note}`.trim();
  return { ...result, reviewResult: { ...result.reviewResult, summary } };
}

/**
 * Marks a clean review for approval: the agent's own submission was
 * accepted, nothing failed, and no finding survived dedupe and verification.
 * The approval is pinned to the reviewed head; without a known head there is
 * nothing to pin it to, so the review stays a comment.
 */
function withApproval(
  result: ReviewAgentResult,
  headSha: string | undefined,
): ReviewAgentResult {
  const { reviewResult } = result;
  const clean =
    result.complete === true &&
    !reviewResult.failure &&
    reviewResult.comments.length === 0;
  if (!clean || !headSha) return result;
  return {
    ...result,
    reviewResult: { ...reviewResult, approve: true, reviewedSha: headSha },
  };
}

/** What a review tier works on: the repo and the rules that apply to it. */
interface ReviewMaterial {
  workspace: RepoWorkspace;
  context?: ResolvedReviewContext;
  rules?: SelectedRules;
}

function fallbackContext(reason: string): ResolvedReviewContext {
  return {
    rules: null,
    metrics: { origin: 'fallback', ruleCount: 0, fallbackReason: reason },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fails open: any error resolving the context falls back to raw guidelines. */
async function resolveContext(
  ctx: PipelineContext,
): Promise<ResolvedReviewContext | undefined> {
  const load = ctx.input.loadReviewContext;
  if (!load) return undefined;
  const timeoutMs = Math.min(
    MAX_CONTEXT_TIMEOUT_MS,
    Math.floor(ctx.remainingMs() / 4),
  );
  try {
    return await load(timeoutMs);
  } catch (error) {
    return fallbackContext(describeError(error));
  }
}

async function loadMaterial(ctx: PipelineContext): Promise<ReviewMaterial> {
  const [workspace, context] = await Promise.all([
    ctx.input.loadWorkspace(),
    resolveContext(ctx),
  ]);
  if (!context?.rules) return { workspace, context };
  const { changedFiles } = workspace.getPrDiff({ maxChars: 0 });
  return {
    workspace,
    context,
    rules: selectRules(context.rules, changedFiles),
  };
}

async function runTier(
  ctx: PipelineContext,
  material: ReviewMaterial,
  tier: 'light' | 'deep',
  focusFiles: string[],
): Promise<ReviewAgentResult> {
  const { prMeta, reviewThreads, incrementalSince } = ctx.input;
  return runCodeReview(
    {
      prMeta,
      workspace: material.workspace,
      priorFindings: ctx.priorFindings,
      focusFiles,
      existingThreads: reviewThreads,
      incrementalSince,
      rules: material.rules,
    },
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

interface ReviewedRun {
  result: ReviewAgentResult;
  route: ReviewRoute;
  /** The tier that produced `result` (deep after an escalation). */
  tier: 'light' | 'deep';
  material: ReviewMaterial;
}

/** Runs the chosen tier; a failed light review is retried once as deep. */
async function review(
  ctx: PipelineContext,
  route: ReviewRoute,
  focusFiles: string[],
): Promise<ReviewedRun> {
  const tier = route.tier === 'light' ? 'light' : 'deep';
  const material = await loadMaterial(ctx);
  const first = await runTier(ctx, material, tier, focusFiles);
  if (!shouldEscalate(ctx, tier, first)) {
    return { result: first, route, tier, material };
  }

  const second = await runTier(ctx, material, 'deep', focusFiles);
  const escalated: ReviewRoute = {
    ...route,
    tier: 'deep',
    reason: `${route.reason} Escalated after the light review failed.`,
  };
  return {
    result: { ...second, usage: sumTokenUsage(first.usage, second.usage) },
    route: escalated,
    tier: 'deep',
    material,
  };
}

/** Drops findings already raised in an existing review thread (any author). */
async function dedupeStep(ctx: PipelineContext, result: ReviewAgentResult) {
  const deduped = await dedupeAgainstThreads({
    findings: result.findings,
    threads: ctx.input.reviewThreads ?? [],
    model: ctx.options.models.triage,
    remainingMs: ctx.remainingMs(),
  });
  return {
    result: withFindings(result, deduped.findings, ctx.priorFindings),
    context: deduped.context,
    note: deduped.note,
    usage: deduped.usage,
  };
}

async function triage(ctx: PipelineContext): Promise<TriageResult> {
  const { prMeta, diffWorkspace, incrementalSince } = ctx.input;
  // Triage may use at most a quarter of what is left, so the review keeps
  // most of the budget even when the overall timeout is short.
  const timeoutMs = Math.min(
    MAX_TRIAGE_TIMEOUT_MS,
    Math.floor(ctx.remainingMs() / 4),
  );
  const result = await runTriage(
    ctx.options.models.triage,
    { prMeta, workspace: diffWorkspace, incrementalSince },
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
  const run = await review(ctx, routing.route, routing.focusFiles);
  const deduped = await dedupeStep(ctx, run.result);
  const verified = await verifyStep({
    prMeta: ctx.input.prMeta,
    workspace: run.material.workspace,
    rules: run.material.rules,
    tier: run.tier,
    result: deduped.result,
    priorFindings: ctx.priorFindings,
    model: ctx.options.models.verifier,
    remainingMs: ctx.remainingMs(),
    context: deduped.context,
  });
  const noted = withRouteNote(verified.result, run.route, [
    deduped.note,
    verified.note,
  ]);
  return {
    publish: withApproval(noted, ctx.input.prMeta.headSha),
    metrics: {
      route: run.route,
      usage: {
        ...contextUsage(run.material.context),
        triage: sumTokenUsage(routing.usage, deduped.usage),
        reviewer: run.result.usage,
        ...(verified.usage ? { verifier: verified.usage } : {}),
      },
      ...contextMetrics(run.material),
    },
  };
}

function contextUsage(
  context: ResolvedReviewContext | undefined,
): Pick<ReviewMetrics['usage'], 'context'> {
  return context?.usage ? { context: context.usage } : {};
}

function contextMetrics(
  material: ReviewMaterial,
): Pick<ReviewMetrics, 'context'> {
  if (!material.context) return {};
  const selectedRules = material.rules ? countSelectedRules(material.rules) : 0;
  return { context: { ...material.context.metrics, selectedRules } };
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
 * free rules → (deep-path rule | triage model) → reviewer at the chosen
 * depth → verifier on the findings that matter.
 * Every model-backed step fails open towards a full review.
 */
export async function runReviewPipeline(
  input: ReviewPipelineInput,
  options: ReviewPipelineOptions,
): Promise<ReviewPipelineResult> {
  const ctx = createContext(input, options);
  const { changedFiles } = input.diffWorkspace.getPrDiff({ maxChars: 0 });

  if (changedFiles.length === 0 && input.incrementalSince) {
    const route: ReviewRoute = {
      tier: 'skip',
      reason: 'No new reviewable changes since the last review.',
      source: 'rule',
    };
    return { publish: null, metrics: { route, usage: {} } };
  }

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
