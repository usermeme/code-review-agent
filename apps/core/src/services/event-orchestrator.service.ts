import { randomUUID } from 'node:crypto';

import { ReviewNotSubmittedError } from '@code-review-agent/agent-code-reviewer';
import {
  IngestPREventRequest,
  IngestPREventResponse,
} from '@code-review-agent/contracts';
import {
  type ContextBuildRequest,
  GitAdapterContract,
  PREventPayload,
  type PRMeta,
  type RepoContext,
  type RepoRef,
  ReviewResultPayload,
  toPrKey,
  toRepoKey,
} from '@code-review-agent/shared-types';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';

import type { CoreEnvService } from '../env.js';
import { GitAdapterClient } from '../modules/adapter/git-adapter.client.js';
import { ContextRepository } from '../modules/database/repositories/context.repository.js';
import { LeaseRepository } from '../modules/database/repositories/lease.repository.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import type { AgentRunner } from './agent.service.js';

/**
 * How long a context build may hold its repo's lease. It must exceed the
 * longest real build (Cloud Run request timeout), otherwise a second build
 * could start while the first is still writing.
 */
export const CONTEXT_BUILD_LEASE_TTL_MS = 60 * 60_000;

const REVIEW_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'review_requested',
  'manual_trigger',
]);

/** Another instance is building this repo's context; the message should be retried later. */
export class ContextBuildInProgressError extends Error {
  constructor(repoKey: string) {
    super(`A context build for ${repoKey} is already running.`);
    this.name = 'ContextBuildInProgressError';
  }
}

interface PullRequestToReview {
  repoRef: RepoRef;
  prNumber: number;
  meta: Pick<PRMeta, 'title' | 'author' | 'branch' | 'body' | 'baseRef'>;
  diff: string;
  changedFiles: string[];
}

export interface EventOrchestratorDependencies {
  envService: CoreEnvService;
  prRepository: PrRepository;
  contextRepository: ContextRepository;
  leaseRepository: LeaseRepository;
  pubsub: PubSub;
  agentService: AgentRunner;
  gitAdapterClient?: GitAdapterContract;
}

export class EventOrchestratorService {
  private pubsub: PubSub;
  private prRepository: PrRepository;
  private contextRepository: ContextRepository;
  private leaseRepository: LeaseRepository;
  private envService: CoreEnvService;
  private agentService: AgentRunner;
  private gitAdapterClient: GitAdapterContract;

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub;
    this.prRepository = deps.prRepository;
    this.contextRepository = deps.contextRepository;
    this.leaseRepository = deps.leaseRepository;
    this.envService = deps.envService;
    this.agentService = deps.agentService;

    const adapterUrl = deps.envService.get('GIT_ADAPTER_URL');
    this.gitAdapterClient =
      deps.gitAdapterClient ?? new GitAdapterClient(adapterUrl);
  }

  async ingestPREvent(
    req: IngestPREventRequest | PREventPayload,
    logger?: FastifyBaseLogger,
  ): Promise<IngestPREventResponse> {
    const meta = req.prMeta;
    if (!meta) {
      return {
        success: false,
        status: 'error',
        message: 'Missing PR metadata',
      } as IngestPREventResponse;
    }

    const { provider, owner, repo, prNumber, action } = meta;
    const repoRef: RepoRef = { provider, owner, repo };
    const prKey = toPrKey(repoRef, prNumber);

    logger?.info(`[Core] Ingesting PR event: ${action} for ${prKey}`);

    if (action === 'closed' && meta.isIncrementalUpdate) {
      return this.queueMergedPr(repoRef, prNumber, logger);
    }

    if (!REVIEW_ACTIONS.has(action)) {
      return {
        success: true,
        status: 'ignored',
        message: `Ignored action: ${action}`,
      } as IngestPREventResponse;
    }

    let diff = req.diff || '';
    let changedFiles = req.changedFiles || [];
    if (!diff || changedFiles.length === 0) {
      try {
        logger?.info(
          `[Core] Fetching diff and changed files from git adapter for ${prKey}`,
        );
        const adapterData = await this.gitAdapterClient.getPRDiff(
          owner,
          repo,
          prNumber,
        );
        diff = adapterData.diff;
        changedFiles = adapterData.changedFiles;
      } catch (err) {
        logger?.warn(
          `[Core] Failed to fetch PR diff from adapter for ${prKey}: ${err}`,
        );
      }
    }

    const pr: PullRequestToReview = {
      repoRef,
      prNumber,
      meta,
      diff,
      changedFiles: Array.isArray(changedFiles) ? changedFiles : [],
    };
    const context = await this.contextRepository.get(toRepoKey(repoRef));
    return context
      ? this.reviewPullRequest(pr, context, logger)
      : this.queueBaselineBuild(pr, logger);
  }

  /**
   * Runs one context-build job from the context-build topic. Builds for the
   * same repo are serialized by a lease; a held lease throws
   * ContextBuildInProgressError so Pub/Sub redelivers later. Every step is
   * idempotent under redelivery: an existing baseline is reused, an already
   * applied PR is skipped, and a pending review is claimed at most once.
   */
  async handleContextBuildRequest(
    req: ContextBuildRequest,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const repoRef: RepoRef = {
      provider: req.provider,
      owner: req.owner,
      repo: req.repo,
    };
    const repoKey = toRepoKey(repoRef);
    const leaseKey = `context-build:${repoKey}`;
    const holder = randomUUID();

    if (
      !(await this.leaseRepository.tryAcquire(
        leaseKey,
        holder,
        CONTEXT_BUILD_LEASE_TTL_MS,
      ))
    ) {
      throw new ContextBuildInProgressError(repoKey);
    }

    let baseline: RepoContext | null = null;
    try {
      if (req.mode === 'baseline') {
        baseline = await this.ensureBaseline(repoRef, req.ref, logger);
      } else {
        await this.applyMergedPr(repoRef, req.prNumber, logger);
      }
    } finally {
      await this.leaseRepository.release(leaseKey, holder);
    }

    if (
      baseline &&
      req.mode === 'baseline' &&
      req.pendingPrNumber !== undefined
    ) {
      await this.reviewPendingPr(
        repoRef,
        req.pendingPrNumber,
        baseline,
        logger,
      );
    }
  }

  async handleReviewResults(
    payload: ReviewResultPayload,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const { provider, owner, repo, prNumber, summary } = payload;
    const prKey = toPrKey({ provider, owner, repo }, prNumber);

    logger?.info(
      `[Core] Handling review results for ${prKey}. Publishing to Review Results topic.`,
    );

    try {
      await this.publishReviewResults(payload);
      await this.prRepository.updatePRStatus(prKey, {
        status: 'completed',
        summary,
      });
    } catch (error) {
      logger?.error(`[Core] Failed to publish review results: ${error}`);
      await this.prRepository.updatePRStatus(prKey, {
        status: 'failed',
        error: String(error),
      });
      throw error;
    }
  }

  /** Parks the PR until its repo has a baseline and queues the build. */
  private async queueBaselineBuild(
    pr: PullRequestToReview,
    logger?: FastifyBaseLogger,
  ): Promise<IngestPREventResponse> {
    const { repoRef, prNumber, meta } = pr;
    await this.prRepository.updatePRStatus(toPrKey(repoRef, prNumber), {
      ...repoRef,
      prNumber,
      status: 'building_context',
      diff: pr.diff,
      changedFiles: pr.changedFiles,
      prMeta: { ...meta },
    });
    await this.publishContextBuild({
      ...repoRef,
      mode: 'baseline',
      ref: meta.baseRef,
      pendingPrNumber: prNumber,
    });
    logger?.info(
      `[Core] No baseline context for ${toRepoKey(repoRef)}; queued a build. PR #${prNumber} is reviewed once it is ready.`,
    );
    return {
      success: true,
      status: 'queued',
      message: 'Baseline context build queued; review follows',
    } as IngestPREventResponse;
  }

  private async queueMergedPr(
    repoRef: RepoRef,
    prNumber: number,
    logger?: FastifyBaseLogger,
  ): Promise<IngestPREventResponse> {
    const repoKey = toRepoKey(repoRef);
    if (!(await this.contextRepository.get(repoKey))) {
      // Nothing to merge into; the next reviewed PR builds a full baseline.
      logger?.info(
        `[Core] No baseline context for ${repoKey}; skipping incremental update for merged PR #${prNumber}.`,
      );
      return {
        success: true,
        status: 'ignored',
        message: 'No baseline context to update',
      } as IngestPREventResponse;
    }
    await this.publishContextBuild({
      ...repoRef,
      mode: 'incremental',
      prNumber,
    });
    return {
      success: true,
      status: 'queued',
      message: 'Incremental context update queued',
    } as IngestPREventResponse;
  }

  private async reviewPendingPr(
    repoRef: RepoRef,
    prNumber: number,
    context: RepoContext,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const prKey = toPrKey(repoRef, prNumber);
    if (!(await this.prRepository.claimPendingReview(prKey))) {
      logger?.info(
        `[Core] ${prKey} is not waiting for a baseline (already reviewed or claimed); skipping.`,
      );
      return;
    }
    const pending = await this.prRepository.getPRStatus(prKey);
    try {
      await this.reviewPullRequest(
        {
          repoRef,
          prNumber,
          meta: {
            title: pending?.prMeta?.title ?? '',
            author: pending?.prMeta?.author ?? '',
            branch: pending?.prMeta?.branch ?? '',
            body: pending?.prMeta?.body,
            baseRef: pending?.prMeta?.baseRef,
          },
          diff: pending?.diff ?? '',
          changedFiles: pending?.changedFiles ?? [],
        },
        context,
        logger,
      );
    } catch (error) {
      // A transient failure (LLM 5xx, publish error) must stay retryable:
      // hand the PR back so the redelivered job can claim it again.
      await this.prRepository.updatePRStatus(prKey, {
        status: 'building_context',
        error: String(error),
      });
      throw error;
    }
  }

  private async reviewPullRequest(
    pr: PullRequestToReview,
    context: RepoContext,
    logger?: FastifyBaseLogger,
  ): Promise<IngestPREventResponse> {
    const { repoRef, prNumber, meta } = pr;
    const prKey = toPrKey(repoRef, prNumber);
    logger?.info(`[Core] Running review for ${prKey}.`);
    await this.prRepository.updatePRStatus(prKey, {
      ...repoRef,
      prNumber,
      status: 'reviewing',
      diff: pr.diff,
      changedFiles: pr.changedFiles,
    });

    try {
      const reviewResult = await this.agentService.runReview({
        prMeta: { ...repoRef, number: prNumber, ...meta },
        diff: pr.diff,
        changedFiles: pr.changedFiles.join('\n'),
        tickets: [],
        context,
      });
      await this.handleReviewResults(reviewResult, logger);
    } catch (error) {
      if (!(error instanceof ReviewNotSubmittedError)) throw error;
      // Not retryable: a redelivery would pay for another full review that
      // fails the same way. Record it and acknowledge the message.
      logger?.error(`[Core] ${error.message}`);
      await this.prRepository.updatePRStatus(prKey, {
        status: 'failed',
        error: error.message,
      });
      return {
        success: false,
        status: 'failed',
        message: error.message,
      } as IngestPREventResponse;
    }

    return {
      success: true,
      status: 'reviewing',
      message: 'Review completed and results published',
    } as IngestPREventResponse;
  }

  private async ensureBaseline(
    repoRef: RepoRef,
    ref: string | undefined,
    logger?: FastifyBaseLogger,
  ): Promise<RepoContext> {
    const repoKey = toRepoKey(repoRef);
    const existing = await this.contextRepository.get(repoKey);
    if (existing) {
      logger?.info(
        `[Core] Baseline for ${repoKey} already exists; reusing it.`,
      );
      return existing;
    }

    logger?.info(`[Core] Building baseline context for ${repoKey}.`);
    const built = await this.agentService.buildRepoContext(
      { mode: 'baseline', owner: repoRef.owner, repo: repoRef.repo, ref },
      logger,
    );
    const context: RepoContext = {
      repoKey,
      sections: built.sections,
      agentDocs: built.agentDocs,
      headSha: built.headSha,
      updatedAt: new Date(),
    };
    await this.contextRepository.save(context);
    return context;
  }

  /**
   * Folds a merged PR into the repo's baseline. Re-checked under the lease:
   * the baseline may be gone, and the PR may already be applied (redelivery).
   */
  private async applyMergedPr(
    repoRef: RepoRef,
    prNumber: number,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const repoKey = toRepoKey(repoRef);
    const existing = await this.contextRepository.get(repoKey);
    if (!existing) {
      // Retrying can't fix this, so acknowledge instead of throwing.
      logger?.warn(
        `[Core] No baseline context for ${repoKey}; dropping merged PR #${prNumber} update.`,
      );
      return;
    }
    if (existing.lastAppliedPrNumber === prNumber) {
      logger?.info(
        `[Core] Merged PR #${prNumber} is already applied to ${repoKey}; skipping.`,
      );
      return;
    }

    const updated = await this.agentService.buildRepoContext(
      {
        mode: 'incremental',
        owner: repoRef.owner,
        repo: repoRef.repo,
        prNumber,
        existing,
      },
      logger,
    );
    await this.contextRepository.save({
      ...existing,
      sections: updated.sections,
      agentDocs: updated.agentDocs,
      lastAppliedPrNumber: prNumber,
      updatedAt: new Date(),
    });
  }

  private async publishContextBuild(req: ContextBuildRequest): Promise<void> {
    const topicName = this.envService.get('CONTEXT_BUILD_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({ json: req });
  }

  private async publishReviewResults(
    payload: ReviewResultPayload,
  ): Promise<void> {
    const topicName = this.envService.get('REVIEW_RESULTS_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });
  }
}
