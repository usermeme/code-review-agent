import {
  loadRepoWorkspaceFromTarball,
  RepoWorkspace,
} from '@code-review-agent/agent-tools';
import type { AgentModels } from '@code-review-agent/llm';
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  type ReviewAgentResult,
  type ReviewPipelineResult,
  runReviewPipeline,
} from '@code-review-agent/review-agent';
import {
  type CommentJudgeMetrics,
  type GitAdapterContract,
  NonRetryableTaskError,
  type PRDiffResult,
  type PREventPayload,
  type PriorFinding,
  type PRMeta,
  type PRState,
  type ReviewMetrics,
  type ReviewResultPayload,
  type ReviewThread,
} from '@code-review-agent/shared-types';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';

import type { CoreEnvService } from '../env.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import type { CommentJudgeService } from './comment-judge/comment-judge.service.js';

export interface PREventResult {
  success: boolean;
  status: 'queued' | 'reviewing' | 'completed' | 'ignored' | 'error';
  message: string;
}

export interface EventOrchestratorDependencies {
  envService: CoreEnvService;
  prRepository: PrRepository;
  pubsub: PubSub;
  gitAdapterClient: GitAdapterContract;
  models: AgentModels;
  /** Checks resolved review threads; without it they are ignored. */
  commentJudge?: CommentJudgeService;
}

const REVIEW_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'review_requested',
  'ready_for_review',
  'manual_trigger',
]);

function judgedCount(metrics: CommentJudgeMetrics | null): number {
  return metrics?.judged ?? 0;
}

function ignored(message: string): PREventResult {
  return { success: true, status: 'ignored', message };
}

function isReviewableAction(action: string): boolean {
  return REVIEW_ACTIONS.has(action);
}

function extractPriorFindings(state: PRState | null): PriorFinding[] {
  if (!state || !state.publishedFindings) {
    return [];
  }
  return state.publishedFindings;
}

/** The diffs one review run works on. */
interface ReviewDiffs {
  /** What the reviewer reads: the whole PR, or only the new pushes. */
  review: PRDiffResult;
  /** Full PR diff when `review` is a delta; comments must anchor inside it. */
  anchor?: PRDiffResult;
  /** Commit the delta starts from, for incremental reviews. */
  since?: string;
}

/** A plain push after an earlier review is reviewed as a delta. */
function incrementalBase(
  meta: PRMeta,
  state: PRState | null,
): string | undefined {
  const since = state?.lastReviewedSha;
  if (meta.action !== 'synchronize' || !meta.headSha) return undefined;
  return since !== meta.headSha ? since : undefined;
}

function resolveTarballRef(meta: PRMeta): string {
  return meta.headSha || meta.branch;
}

export class EventOrchestratorService {
  private readonly pubsub: PubSub;
  private readonly prRepository: PrRepository;
  private readonly envService: CoreEnvService;
  private readonly gitAdapterClient: GitAdapterContract;
  private readonly models: AgentModels;
  private readonly commentJudge?: CommentJudgeService;

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub;
    this.prRepository = deps.prRepository;
    this.envService = deps.envService;
    this.gitAdapterClient = deps.gitAdapterClient;
    this.models = deps.models;
    this.commentJudge = deps.commentJudge;
  }

  async ingestPREvent(
    req: PREventPayload,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
    const meta = req.prMeta;
    if (!meta) {
      return {
        success: false,
        status: 'error',
        message: 'Missing PR metadata',
      };
    }

    const { provider, owner, repo, prNumber, action } = meta;
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;

    if (logger) {
      logger.info(`[Core] Ingesting PR event: ${action} for ${prKey}`);
    }

    if (action === 'thread_resolved') {
      return this.judgeResolvedThread(meta, logger);
    }

    if (!isReviewableAction(action)) {
      return ignored(`Ignored action: ${action}`);
    }
    return this.handleReviewEvent(meta, prKey, logger);
  }

  /** Reviews the PR and, on a push, judges threads waiting for that push. */
  private async handleReviewEvent(
    meta: PRMeta,
    prKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
    // A push can carry the fix a resolved thread was waiting for.
    const judging =
      meta.action === 'synchronize'
        ? this.judgeAfterPush(meta, logger)
        : Promise.resolve();
    const [review] = await Promise.allSettled([
      this.reviewIfEnabled(meta, prKey, logger),
      judging,
    ]);
    if (review.status === 'rejected') throw review.reason;
    return review.value;
  }

  private isEnabled(
    flag: 'CODE_REVIEW_ENABLED' | 'COMMENT_JUDGE_ENABLED',
  ): boolean {
    // Unset means on; only an explicit `false` turns a feature off.
    return this.envService.get(flag) !== false;
  }

  private async reviewIfEnabled(
    meta: PRMeta,
    prKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
    if (!this.isEnabled('CODE_REVIEW_ENABLED')) {
      return ignored('Code review is disabled.');
    }
    return this.processReview(meta, prKey, logger);
  }

  /**
   * A failure here is left to Pub/Sub's retry: the thread is already
   * queued, so a redelivery judges it without queueing it twice.
   */
  private async judgeResolvedThread(
    meta: PRMeta,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
    const judge = this.activeJudge();
    if (!judge) return ignored('Comment judge is disabled.');
    const metrics = await judge.run(meta, 'resolved', logger);
    logger?.info(
      { judgment: metrics },
      `[Core] Comment judge ran for ${meta.owner}/${meta.repo} #${meta.prNumber}`,
    );
    return {
      success: true,
      status: 'completed',
      message: `Judged ${judgedCount(metrics)} resolved thread(s)`,
    };
  }

  /** The comment judge when it is wired and switched on. */
  private activeJudge(): CommentJudgeService | undefined {
    return this.isEnabled('COMMENT_JUDGE_ENABLED')
      ? this.commentJudge
      : undefined;
  }

  /** Never fails the push's review: waiting threads are retried next time. */
  private async judgeAfterPush(
    meta: PRMeta,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const judge = this.activeJudge();
    if (!judge) return;
    try {
      await judge.run(meta, 'push', logger);
    } catch (error) {
      logger?.warn({ err: error }, '[Core] Comment judge failed after a push');
    }
  }

  async publishReviewResults(payload: ReviewResultPayload): Promise<void> {
    const topicName = this.envService.get('REVIEW_RESULTS_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });
  }

  private async fetchDiff(meta: PRMeta): Promise<PRDiffResult> {
    return this.gitAdapterClient.getPRDiff(
      meta.owner,
      meta.repo,
      meta.prNumber,
    );
  }

  /**
   * Existing review threads only sharpen dedup; a failure to read them
   * (e.g. missing GraphQL permission) must not block the review.
   */
  private async fetchThreads(
    meta: PRMeta,
    logger?: FastifyBaseLogger,
  ): Promise<ReviewThread[]> {
    try {
      return await this.gitAdapterClient.getReviewThreads(
        meta.owner,
        meta.repo,
        meta.prNumber,
      );
    } catch (error) {
      logger?.warn(
        { err: error },
        '[Core] Could not read review threads; continuing without them',
      );
      return [];
    }
  }

  /**
   * Compare diff since `since`, or undefined when the branch was rewritten
   * (force-push/rebase) or the compare failed: those get a full review.
   */
  private async fetchDelta(
    meta: PRMeta,
    since: string,
    logger?: FastifyBaseLogger,
  ): Promise<PRDiffResult | undefined> {
    try {
      const compare = await this.gitAdapterClient.getCompareDiff(
        meta.owner,
        meta.repo,
        since,
        meta.headSha ?? '',
      );
      return compare.status === 'ahead' ? compare : undefined;
    } catch (error) {
      logger?.warn(
        { err: error },
        '[Core] Compare failed; falling back to a full review',
      );
      return undefined;
    }
  }

  private async fetchDiffs(
    meta: PRMeta,
    prKey: string,
    state: PRState | null,
    logger?: FastifyBaseLogger,
  ): Promise<ReviewDiffs> {
    const since = incrementalBase(meta, state);
    const [full, delta] = await Promise.all([
      this.callAdapter(meta, prKey, () => this.fetchDiff(meta)),
      since ? this.fetchDelta(meta, since, logger) : undefined,
    ]);
    if (!since || !delta) return { review: full };
    return { review: delta, anchor: full, since };
  }

  private async loadWorkspace(
    meta: PRMeta,
    diffs: ReviewDiffs,
  ): Promise<RepoWorkspace> {
    const tarball = await this.gitAdapterClient.getRepoTarball(
      meta.owner,
      meta.repo,
      resolveTarballRef(meta),
    );
    return loadRepoWorkspaceFromTarball(tarball, {
      rawDiff: diffs.review.diff,
      changedFiles: diffs.review.changedFiles,
      anchorRawDiff: diffs.anchor?.diff,
    });
  }

  private async handleNonRetryableError(
    meta: PRMeta,
    prKey: string,
    error: NonRetryableTaskError,
  ): Promise<never> {
    const summary = `Review failed: ${error.message}`;
    await this.prRepository.updatePRStatus(prKey, {
      status: 'failed',
      error: error.message,
      summary,
    });
    await this.publishReviewResults({
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      comments: [],
      summary,
      failure: { reason: error.message },
    });
    throw error;
  }

  /** Runs a git-adapter call; a non-retryable failure is published to the PR. */
  private async callAdapter<T>(
    meta: PRMeta,
    prKey: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof NonRetryableTaskError) {
        return this.handleNonRetryableError(meta, prKey, error);
      }
      throw error;
    }
  }

  private async executeReview(
    meta: PRMeta,
    prKey: string,
    state: PRState | null,
    logger?: FastifyBaseLogger,
  ): Promise<ReviewPipelineResult> {
    const [diffs, reviewThreads] = await Promise.all([
      this.fetchDiffs(meta, prKey, state, logger),
      this.fetchThreads(meta, logger),
    ]);
    if (diffs.since) {
      logger?.info(
        `[Core] Incremental review of ${prKey} since ${diffs.since}`,
      );
    }
    const diffWorkspace = new RepoWorkspace({
      files: new Map(),
      rawDiff: diffs.review.diff,
      changedFiles: diffs.review.changedFiles,
      anchorRawDiff: diffs.anchor?.diff,
    });
    return runReviewPipeline(
      {
        prMeta: meta,
        diffWorkspace,
        loadWorkspace: () =>
          this.callAdapter(meta, prKey, () => this.loadWorkspace(meta, diffs)),
        priorFindings: extractPriorFindings(state),
        reviewThreads,
        incrementalSince: diffs.since,
      },
      {
        models: this.models,
        timeoutMs:
          this.envService.get('REVIEW_TIMEOUT_MS') ?? DEFAULT_REVIEW_TIMEOUT_MS,
        deepReviewPaths: this.envService.get('DEEP_REVIEW_PATHS'),
      },
    );
  }

  private async persistSkip(
    prKey: string,
    metrics: ReviewMetrics,
  ): Promise<PREventResult> {
    await this.prRepository.updatePRStatus(prKey, {
      status: 'skipped',
      summary: metrics.route.reason,
      lastReview: metrics,
    });
    return {
      success: true,
      status: 'ignored',
      message: `Review skipped: ${metrics.route.reason}`,
    };
  }

  private async persistReviewResult(
    prKey: string,
    meta: PRMeta,
    result: ReviewAgentResult,
    metrics: ReviewMetrics,
  ): Promise<PREventResult> {
    const failureReason = result.reviewResult.failure?.reason;
    if (failureReason) {
      await this.prRepository.updatePRStatus(prKey, {
        status: 'failed',
        error: failureReason,
        summary: result.reviewResult.summary,
        lastReview: metrics,
      });
      return {
        success: false,
        status: 'error',
        message: failureReason,
      };
    }

    await this.prRepository.updatePRStatus(prKey, {
      status: 'completed',
      summary: result.reviewResult.summary,
      publishedFindings: result.publishedFindings,
      lastReview: metrics,
      // The next push is reviewed as a delta from this commit.
      ...(meta.headSha ? { lastReviewedSha: meta.headSha } : {}),
    });
    return {
      success: true,
      status: 'completed',
      message: 'PR review completed',
    };
  }

  private async processReview(
    meta: PRMeta,
    prKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
    const existing = await this.prRepository.getPRStatus(prKey);

    await this.prRepository.updatePRStatus(prKey, {
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      status: 'reviewing',
    });

    const { publish, metrics } = await this.executeReview(
      meta,
      prKey,
      existing,
      logger,
    );
    logger?.info(
      { route: metrics.route, usage: metrics.usage },
      `[Core] Review route for ${prKey}: ${metrics.route.tier} (${metrics.route.source})`,
    );
    if (!publish) {
      return this.persistSkip(prKey, metrics);
    }
    await this.publishReviewResults(publish.reviewResult);
    return this.persistReviewResult(prKey, meta, publish, metrics);
  }
}
