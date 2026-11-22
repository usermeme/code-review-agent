import {
  loadRepoWorkspaceFromTarball,
  type RepoWorkspace,
} from '@code-review-agent/agent-tools';
import { emptyTokenUsage, sumTokenUsage } from '@code-review-agent/llm';
import {
  type CommentJudgeResult,
  runCommentJudge,
} from '@code-review-agent/review-agent';
import type {
  CommentJudgeMetrics,
  GitAdapterContract,
  PRMeta,
  ReviewThread,
  ThreadJudgmentAction,
  ThreadJudgmentDoc,
  ThreadJudgmentsPayload,
  TokenUsage,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { ThinkingLevel } from '@google/genai';
import type { FastifyBaseLogger } from 'fastify';

import type { DeliveryRepository } from '../../modules/database/repositories/delivery.repository.js';
import type { PrRepository } from '../../modules/database/repositories/pr.repository.js';
import {
  threadJudgmentId,
  type ThreadJudgmentRepository,
} from '../../modules/database/repositories/thread-judgment.repository.js';
import { buildJudgeThreads } from './judge-evidence.js';
import {
  isAwaitingJudgment,
  planThread,
  type ThreadPlan,
} from './thread-plan.js';
import {
  applyVerdict,
  type JudgedThread,
  type VerdictOutcome,
} from './verdicts.js';

const MAX_THREADS_PER_BATCH = 10;
const MAX_BATCHES_PER_RUN = 3;
/** Threads beyond this stay queued, unclaimed, for the next event or push. */
const MAX_THREADS_PER_RUN = MAX_THREADS_PER_BATCH * MAX_BATCHES_PER_RUN;
const JUDGE_PROFILE = {
  thinkingLevel: ThinkingLevel.HIGH,
  maxLlmCalls: 6,
  timeoutMs: 150_000,
};

export type JudgeTrigger = 'resolved' | 'push';

export interface CommentJudgeServiceDependencies {
  gitAdapterClient: GitAdapterContract;
  judgments: ThreadJudgmentRepository;
  /** Per-thread claims, so parallel runs never judge a thread twice. */
  claims: DeliveryRepository;
  prRepository: PrRepository;
  /** The smart model (the reviewer's). */
  model: BaseLlm;
  /** Sends the GitHub actions to the adapter (review-results topic). */
  publish: (payload: ThreadJudgmentsPayload) => Promise<void>;
  now?: () => number;
}

type JudgePlan = Extract<ThreadPlan, { kind: 'judge' }>;

interface PlannedThreads {
  judge: JudgePlan[];
  pending: ThreadPlan[];
  skipped: Extract<ThreadPlan, { kind: 'skip' }>[];
}

interface Claimed extends JudgePlan {
  claimKey: string;
}

interface BatchResults {
  judged: JudgedThread[];
  usage: TokenUsage;
  failure?: string;
}

interface JudgeRun {
  metrics: CommentJudgeMetrics;
  /** Claimed threads this run could not judge; they stay queued. */
  unjudged: Set<string>;
}

/**
 * Thrown on a `resolved` run that failed to judge the event's own thread,
 * so Pub/Sub redelivers the event instead of acking it. The thread stays
 * queued and its claim is released, so the redelivery judges it.
 */
export class CommentJudgeRunError extends Error {
  constructor(failure: string) {
    super(`Comment judge failed: ${failure}`);
    this.name = 'CommentJudgeRunError';
  }
}

function prKeyOf(meta: PRMeta): string {
  return `${meta.provider}:${meta.owner}:${meta.repo}:${meta.prNumber}`;
}

function docIdOf(doc: ThreadJudgmentDoc): string {
  return threadJudgmentId(doc.prKey, doc.threadId);
}

function claimKeyOf(doc: ThreadJudgmentDoc): string {
  return `judge:${docIdOf(doc)}:${doc.queuedAtMs}`;
}

function chunk<Item>(items: Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function planAll(
  docs: ThreadJudgmentDoc[],
  threads: ReviewThread[],
  headSha: string,
): PlannedThreads {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const plans = docs.map((doc) =>
    planThread(doc, byId.get(doc.threadId), headSha),
  );
  return {
    judge: plans.filter((plan): plan is JudgePlan => plan.kind === 'judge'),
    pending: plans.filter((plan) => plan.kind === 'pending'),
    skipped: plans.filter(
      (plan): plan is PlannedThreads['skipped'][number] => plan.kind === 'skip',
    ),
  };
}

function judgedFrom(
  batch: Claimed[],
  result: CommentJudgeResult,
): JudgedThread[] {
  return batch.flatMap(({ doc, thread }) => {
    const judgment = result.judgments.get(thread.id);
    return judgment ? [{ doc, thread, judgment }] : [];
  });
}

/** A re-resolved thread keeps its failed-check count and history. */
function carriedOver(
  existing: ThreadJudgmentDoc | null,
): Pick<ThreadJudgmentDoc, 'notFixedCount' | 'history'> {
  if (!existing) return { notFixedCount: 0, history: [] };
  return {
    notFixedCount: existing.notFixedCount ?? 0,
    history: existing.history ?? [],
  };
}

function emptyMetrics(judgedAt: Date): CommentJudgeMetrics {
  return {
    judgedAt,
    judged: 0,
    verdicts: { fixed: 0, not_fixed: 0, accepted: 0 },
    pending: 0,
    skipped: 0,
    escalated: 0,
    usage: emptyTokenUsage(),
  };
}

/**
 * Judges resolved review threads: was the comment really resolved at the
 * PR head? Only threads a `resolved` event queued are judged, so turning
 * the judge on never sweeps up threads resolved before it existed.
 */
export class CommentJudgeService {
  private readonly deps: CommentJudgeServiceDependencies;
  private readonly now: () => number;

  constructor(deps: CommentJudgeServiceDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * `resolved` queues the event's thread first; `push` only picks up
   * threads that were waiting for a new commit. Returns null when there was
   * nothing to judge. A `resolved` run throws `CommentJudgeRunError` when a
   * failure left the event's thread unjudged; a `push` run never does, as
   * its review must not be retried for the judge's sake.
   */
  async run(
    meta: PRMeta,
    trigger: JudgeTrigger,
    logger?: FastifyBaseLogger,
  ): Promise<CommentJudgeMetrics | null> {
    if (!meta.headSha) return null;
    const prKey = prKeyOf(meta);
    const awaiting = await this.awaitingDocs(meta, prKey, trigger);
    if (awaiting.length === 0) return null;
    const run = await this.judgeAwaiting(
      meta,
      meta.headSha,
      prKey,
      awaiting,
      logger,
    );
    if (trigger === 'resolved') throwIfLeftUnjudged(run, meta.threadId);
    return run.metrics;
  }

  private async awaitingDocs(
    meta: PRMeta,
    prKey: string,
    trigger: JudgeTrigger,
  ): Promise<ThreadJudgmentDoc[]> {
    if (trigger === 'resolved' && meta.threadId) {
      await this.queue(meta, prKey, meta.threadId);
    }
    const docs = await this.deps.judgments.findByPr(prKey);
    return docs.filter(isAwaitingJudgment);
  }

  private async queue(meta: PRMeta, prKey: string, threadId: string) {
    const id = threadJudgmentId(prKey, threadId);
    const existing = await this.deps.judgments.get(id);
    if (existing?.status === 'escalated') return;
    await this.deps.judgments.save(id, {
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      prKey,
      threadId,
      status: 'queued',
      queuedAtMs: this.now(),
      ...carriedOver(existing),
    });
  }

  private async judgeAwaiting(
    meta: PRMeta,
    headSha: string,
    prKey: string,
    awaiting: ThreadJudgmentDoc[],
    logger?: FastifyBaseLogger,
  ): Promise<JudgeRun> {
    const threads = await this.deps.gitAdapterClient.getReviewThreads(
      meta.owner,
      meta.repo,
      meta.prNumber,
    );
    const plans = planAll(awaiting, threads, headSha);
    await this.recordWaiting(plans);
    const claimed = await this.claim(plans.judge.slice(0, MAX_THREADS_PER_RUN));
    const run = await this.judgeClaimed(meta, headSha, claimed, logger);
    run.metrics.pending = plans.pending.length;
    run.metrics.skipped = plans.skipped.length;
    await this.deps.prRepository.updatePRStatus(prKey, {
      lastJudgment: run.metrics,
    });
    return run;
  }

  /** Stores which threads wait for a push and which were skipped, and why. */
  private async recordWaiting(plans: PlannedThreads): Promise<void> {
    const writes = [
      ...plans.pending.map((plan) =>
        this.deps.judgments.save(docIdOf(plan.doc), { status: 'pending' }),
      ),
      ...plans.skipped.map((plan) =>
        this.deps.judgments.save(docIdOf(plan.doc), {
          status: 'skipped',
          skipReason: plan.reason,
        }),
      ),
    ];
    await Promise.all(writes);
  }

  private async claim(plans: JudgePlan[]): Promise<Claimed[]> {
    const claimed = await Promise.all(
      plans.map(async (plan) => {
        const claimKey = claimKeyOf(plan.doc);
        const won = await this.deps.claims.claim(claimKey);
        return won ? { ...plan, claimKey } : null;
      }),
    );
    return claimed.filter((item): item is Claimed => item !== null);
  }

  private async judgeClaimed(
    meta: PRMeta,
    headSha: string,
    claimed: Claimed[],
    logger?: FastifyBaseLogger,
  ): Promise<JudgeRun> {
    const metrics = emptyMetrics(new Date(this.now()));
    if (claimed.length === 0) return { metrics, unjudged: new Set() };
    try {
      const results = await this.judgeBatches(meta, headSha, claimed);
      await this.settle(meta, headSha, claimed, results, metrics);
      return {
        metrics: { ...metrics, usage: results.usage, ...failureOf(results) },
        unjudged: unjudgedIds(claimed, results.judged),
      };
    } catch (error) {
      logger?.warn({ err: error }, '[Core] Comment judge run failed');
      await this.releaseAll(claimed);
      return {
        metrics: { ...metrics, failure: describeError(error) },
        unjudged: unjudgedIds(claimed, []),
      };
    }
  }

  private async judgeBatches(
    meta: PRMeta,
    headSha: string,
    claimed: Claimed[],
  ): Promise<BatchResults> {
    const results: BatchResults = { judged: [], usage: emptyTokenUsage() };
    const batches = chunk(claimed, MAX_THREADS_PER_BATCH);
    const loadWorkspace = this.workspaceLoader(meta, headSha);
    for (const batch of batches) {
      const evidence = await buildJudgeThreads(
        this.deps.gitAdapterClient,
        meta,
        headSha,
        batch.map((item) => item.thread),
      );
      const result = await runCommentJudge(
        { prMeta: meta, threads: evidence, loadWorkspace },
        { model: this.deps.model, ...JUDGE_PROFILE },
      );
      results.judged.push(...judgedFrom(batch, result));
      results.usage = sumTokenUsage(results.usage, result.usage);
      results.failure ??= result.error;
    }
    return results;
  }

  /** One tarball per run, downloaded only if a tool call needs the repo. */
  private workspaceLoader(meta: PRMeta, headSha: string) {
    let workspace: Promise<RepoWorkspace> | undefined;
    return () => {
      workspace ??= this.deps.gitAdapterClient
        .getRepoTarball(meta.owner, meta.repo, headSha)
        .then((tarball) => loadRepoWorkspaceFromTarball(tarball));
      return workspace;
    };
  }

  /**
   * Publishes first and records second: if publishing fails, the threads
   * are still queued and the next run judges them again, instead of being
   * recorded as judged with nothing posted on GitHub.
   */
  private async settle(
    meta: PRMeta,
    headSha: string,
    claimed: Claimed[],
    results: BatchResults,
    metrics: CommentJudgeMetrics,
  ): Promise<void> {
    const context = {
      headSha,
      model: this.deps.model.model,
      judgedAt: new Date(this.now()),
    };
    const outcomes = results.judged.map((item) => ({
      item,
      outcome: applyVerdict(item, context),
    }));
    await this.publishActions(
      meta,
      outcomes.map(({ outcome }) => outcome),
    );
    await Promise.all(
      outcomes.map(({ item, outcome }) =>
        this.deps.judgments.save(docIdOf(item.doc), outcome.fields),
      ),
    );
    countVerdicts(
      metrics,
      results.judged,
      outcomes.map(({ outcome }) => outcome),
    );
    await this.finishClaims(claimed, results.judged);
  }

  private async publishActions(
    meta: PRMeta,
    outcomes: VerdictOutcome[],
  ): Promise<void> {
    const actions = outcomes
      .map((outcome) => outcome.action)
      .filter((action): action is ThreadJudgmentAction => action !== undefined);
    if (actions.length === 0) return;
    await this.deps.publish({
      kind: 'thread-judgments',
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      actions,
      dismissApprovals: actions.some((action) => action.type === 'reopen'),
    });
  }

  /** Judged threads are done; the rest stay queued for the next run. */
  private async finishClaims(
    claimed: Claimed[],
    judged: JudgedThread[],
  ): Promise<void> {
    const judgedIds = new Set(judged.map((item) => item.thread.id));
    await Promise.all(
      claimed.map((item) =>
        judgedIds.has(item.thread.id)
          ? this.deps.claims.markDone(item.claimKey)
          : this.deps.claims.release(item.claimKey),
      ),
    );
  }

  private async releaseAll(claimed: Claimed[]): Promise<void> {
    await Promise.all(
      claimed.map((item) =>
        this.deps.claims.release(item.claimKey).catch(() => undefined),
      ),
    );
  }
}

function unjudgedIds(claimed: Claimed[], judged: JudgedThread[]): Set<string> {
  const judgedIds = new Set(judged.map((item) => item.thread.id));
  return new Set(
    claimed
      .map((item) => item.thread.id)
      .filter((threadId) => !judgedIds.has(threadId)),
  );
}

/**
 * Only the event's own thread decides. Other threads failed here stay
 * queued for the next event or push; a thread another run claimed is that
 * run's to judge.
 */
function throwIfLeftUnjudged(run: JudgeRun, threadId?: string): void {
  const { failure } = run.metrics;
  if (failure && threadId && run.unjudged.has(threadId)) {
    throw new CommentJudgeRunError(failure);
  }
}

function failureOf(
  results: BatchResults,
): Pick<CommentJudgeMetrics, 'failure'> {
  return results.failure ? { failure: results.failure } : {};
}

function countVerdicts(
  metrics: CommentJudgeMetrics,
  judged: JudgedThread[],
  outcomes: VerdictOutcome[],
): void {
  metrics.judged = judged.length;
  for (const item of judged) metrics.verdicts[item.judgment.verdict] += 1;
  metrics.escalated = outcomes.filter((outcome) => outcome.escalated).length;
}
