import { randomUUID } from 'node:crypto';

import {
  parseBaselineSections,
  prepareDiff,
  type ReviewExecutionInput,
  type RunReviewOptions,
  type StoreDiscussionInput,
} from '@code-review-agent/agent-code-reviewer';
import type { ContextLoader } from '@code-review-agent/agent-context-builder';
import {
  ContextReadyPayload,
  GitAdapterContract,
  NonRetryableTaskError,
  PREventPayload,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';

import type { CoreEnvService } from '../env.js';
import { BaselineLockRepository } from '../modules/database/repositories/baseline-lock.repository.js';
import { ContextRepository } from '../modules/database/repositories/context.repository.js';
import { DiscussionRepository } from '../modules/database/repositories/discussion.repository.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import type { AgentService } from './agent.service.js';

/** Poll interval and total wait while another instance holds the baseline lock. */
const BASELINE_LOCK_POLL_MS = 5_000;
const BASELINE_LOCK_WAIT_MS = 20 * 60 * 1000;

interface BaselineBuildParams {
  baselineKey: string;
  prKey: string;
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  meta: {
    title?: string;
    author?: string;
    branch?: string;
    body?: string;
    cloneUrl?: string;
    baseRef?: string;
  };
  diff: string;
  changedFiles?: string[];
  logger?: FastifyBaseLogger;
}

export interface PREventResult {
  success: boolean;
  status: 'queued' | 'reviewing' | 'ignored' | 'duplicate' | 'failed' | 'error';
  message: string;
}

export interface EventOrchestratorDependencies {
  envService: CoreEnvService;
  prRepository: PrRepository;
  contextRepository: ContextRepository;
  /** Optional cross-instance lock for baseline builds (Firestore-backed). */
  baselineLockRepository?: BaselineLockRepository;
  /** Optional review-discussion memory backing getDiscussion/storeDiscussion. */
  discussionRepository?: DiscussionRepository;
  pubsub: PubSub;
  agentService: AgentService;
  gitAdapterClient: GitAdapterContract;
  llm: BaseLlm;
  /** Optional cheaper model for context-build chunk summarization. */
  summaryLlm?: BaseLlm;
}

export class EventOrchestratorService {
  private pubsub: PubSub;
  private prRepository: PrRepository;
  private contextRepository: ContextRepository;
  private baselineLockRepository?: BaselineLockRepository;
  private discussionRepository?: DiscussionRepository;
  private envService: CoreEnvService;
  private agentService: AgentService;
  private gitAdapterClient: GitAdapterContract;
  private llm: BaseLlm;
  private summaryLlm?: BaseLlm;
  /** Unique per-process id, used as the baseline-lock owner. */
  private readonly lockOwner = randomUUID();
  /**
   * In-process dedup for baseline builds: concurrent PR events (or Pub/Sub
   * push retries) for the same repo must not trigger two full tarball
   * downloads + summarization runs. Cross-instance dedup is handled by the
   * optional Firestore-backed baselineLockRepository.
   */
  private readonly baselineBuilds = new Map<string, Promise<string>>();

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub;
    this.prRepository = deps.prRepository;
    this.contextRepository = deps.contextRepository;
    this.baselineLockRepository = deps.baselineLockRepository;
    this.discussionRepository = deps.discussionRepository;
    this.envService = deps.envService;
    this.agentService = deps.agentService;
    this.gitAdapterClient = deps.gitAdapterClient;
    this.llm = deps.llm;
    this.summaryLlm = deps.summaryLlm;
  }

  /** Guards against saving/using an "empty" context payload (cache poisoning). */
  private isValidSummary(
    summary: string | null | undefined,
  ): summary is string {
    const trimmed = summary?.trim();
    return !!trimmed && trimmed !== '{}' && trimmed !== '{"summary":""}';
  }

  /** Loads a persisted baseline context and parses it into named sections. */
  private createContextLoader(): ContextLoader {
    return async (key: string) => {
      const stored = await this.contextRepository.getContext(key);
      if (!stored?.summary) return null;
      const sections = parseBaselineSections(stored.summary);
      return Object.keys(sections).length > 0 ? sections : null;
    };
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
    const baselineKey = `${provider}:${owner}:${repo}:0`;

    logger?.info(`[Core] Ingesting PR event: ${action} for ${prKey}`);

    // If PR is merged, trigger incremental context update in-process
    if (action === 'closed' && meta.isIncrementalUpdate) {
      logger?.info(
        `[Core] PR merged event for ${prKey}. Triggering incremental context build.`,
      );
      const sections = await this.agentService.buildContext({
        provider,
        owner,
        repo,
        prNumber,
        cloneUrl: meta.cloneUrl,
        ref: meta.baseRef,
        isIncrementalUpdate: true,
        llm: this.llm,
        summaryLlm: this.summaryLlm,
        contextLoader: this.createContextLoader(),
        gitAdapter: this.gitAdapterClient,
      });

      const summary =
        typeof sections === 'string' ? sections : JSON.stringify(sections);
      await this.contextRepository.saveContext(baselineKey, { summary });

      return {
        success: true,
        status: 'queued',
        message: 'Incremental context build completed for merged PR',
      };
    }

    if (
      action === 'opened' ||
      action === 'synchronize' ||
      action === 'reopened' ||
      action === 'review_requested' ||
      action === 'manual_trigger'
    ) {
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

      // Filter and cap once, before the diff is stored or sent to any LLM:
      // Firestore rejects documents over 1 MiB, and a failed write here would
      // fail (and redeliver) the whole event.
      diff = prepareDiff(diff).diff;

      // Check if baseline context exists in Firestore
      const existingContext =
        await this.contextRepository.getContext(baselineKey);

      const storedSummary = existingContext?.summary;
      const baselineSummary =
        (this.isValidSummary(storedSummary) ? storedSummary : null) ??
        (await this.buildAndSaveBaselineContext({
          baselineKey,
          prKey,
          provider,
          owner,
          repo,
          prNumber,
          meta,
          diff,
          changedFiles,
          logger,
        }));

      // Run review in-process
      logger?.info(
        `[Core] Baseline context ready. Running review for ${prKey} in-process.`,
      );
      await this.prRepository.updatePRStatus(prKey, {
        provider,
        owner,
        repo,
        prNumber,
        status: 'reviewing',
        diff,
        changedFiles,
      });

      const changedFilesStr = Array.isArray(changedFiles)
        ? changedFiles.join('\n')
        : (changedFiles ?? '');

      const reviewResult = await this.runReviewOrFail(
        prKey,
        {
          prMeta: {
            provider,
            owner,
            repo,
            number: prNumber,
            title: meta.title,
            author: meta.author,
            branch: meta.branch,
            body: meta.body,
            baseRef: meta.baseRef,
            headSha: meta.headSha,
          },
          diff,
          changedFiles: changedFilesStr,
          tickets: [],
        },
        this.createRunReviewOptions(baselineSummary),
      );

      await this.handleReviewResults(reviewResult, prKey, logger);

      return {
        success: true,
        status: 'reviewing',
        message: 'Review completed and results published',
      };
    }

    return {
      success: true,
      status: 'ignored',
      message: `Ignored action: ${action}`,
    };
  }

  async handleContextReady(
    payload: ContextReadyPayload,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const { provider, owner, repo, prNumber, summary } = payload;
    const baselineKey = `${provider}:${owner}:${repo}:0`;

    logger?.info(`[Core] Context is ready. Saving to baseline: ${baselineKey}`);
    await this.contextRepository.saveContext(baselineKey, { summary });

    if (prNumber === 0) {
      logger?.info(`[Core] Baseline context updated for repo: ${baselineKey}`);
      return;
    }

    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;
    const pendingPR = await this.prRepository.getPRStatus(prKey);

    logger?.info(`[Core] Triggering code review for ${prKey}`);
    await this.prRepository.updatePRStatus(prKey, { status: 'reviewing' });

    const changedFilesStr = Array.isArray(pendingPR?.changedFiles)
      ? pendingPR.changedFiles.join('\n')
      : (pendingPR?.changedFiles ?? '');

    const reviewResult = await this.runReviewOrFail(
      prKey,
      {
        prMeta: {
          provider,
          owner,
          repo,
          number: prNumber,
          title: pendingPR?.prMeta?.['title'] || '',
          author: pendingPR?.prMeta?.['author'] || '',
          branch: pendingPR?.prMeta?.['branch'] || '',
          body: pendingPR?.prMeta?.['body'] || '',
          baseRef: pendingPR?.prMeta?.['baseRef'],
        },
        diff: pendingPR?.diff || '',
        changedFiles: changedFilesStr,
        tickets: [],
      },
      this.createRunReviewOptions(summary),
    );

    await this.handleReviewResults(reviewResult, prKey, logger);
  }

  /**
   * runReview options shared by both review call sites. When a discussion
   * repository is configured, the agent's getDiscussion/storeDiscussion tools
   * are backed by it; otherwise they stay unregistered.
   */
  private createRunReviewOptions(baselineContext: string): RunReviewOptions {
    const discussionRepository = this.discussionRepository;
    return {
      llm: this.llm,
      baselineContext,
      gitAdapter: this.gitAdapterClient,
      ...(discussionRepository
        ? {
            searchDiscussions: (repo: string, query: string, limit: number) =>
              discussionRepository.search(repo, query, limit),
            storeDiscussion: (input: StoreDiscussionInput) =>
              discussionRepository.store(input),
          }
        : {}),
    };
  }

  /**
   * Runs the review; on failure marks the PR as failed and rethrows so the
   * failure is visible (Pub/Sub nack / 500) instead of silently publishing a
   * misleading "no findings" review.
   */
  private async runReviewOrFail(
    prKey: string,
    input: ReviewExecutionInput,
    options: RunReviewOptions,
  ): Promise<ReviewResultPayload> {
    try {
      return await this.agentService.runReview(input, options);
    } catch (error) {
      await this.prRepository
        .updatePRStatus(prKey, { status: 'failed', error: String(error) })
        .catch(() => {
          // status bookkeeping must not mask the original failure
        });
      throw error;
    }
  }

  async handleReviewResults(
    payload: ReviewResultPayload,
    expectedPrKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const { provider, owner, repo, prNumber, summary } = payload;
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;

    // Correlation check at the trust boundary: the review must carry the
    // coordinates of the event that triggered it. A payload redirected to
    // another repo/PR (e.g. by prompt injection) is rejected before it is
    // ever published to the results topic.
    if (prKey !== expectedPrKey) {
      // Deterministic, and it fires after a fully paid review: a redelivery
      // would pay again and be rejected again.
      throw new NonRetryableTaskError(
        `Review result coordinates (${prKey}) do not match the originating PR event (${expectedPrKey}); refusing to publish.`,
      );
    }

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

  private buildAndSaveBaselineContext(
    params: BaselineBuildParams,
  ): Promise<string> {
    // Dedup concurrent baseline builds for the same repository (e.g. an
    // 'opened' + 'review_requested' pair, or a Pub/Sub push retry after a
    // timeout): reuse the in-flight build instead of paying for a second
    // tarball download + full summarization run.
    const inFlight = this.baselineBuilds.get(params.baselineKey);
    if (inFlight !== undefined) {
      params.logger?.info(
        `[Core] Baseline build for ${params.baselineKey} already in flight; awaiting it.`,
      );
      return inFlight;
    }

    const build = this.doBuildAndSaveBaselineContext(params).finally(() => {
      this.baselineBuilds.delete(params.baselineKey);
    });
    this.baselineBuilds.set(params.baselineKey, build);
    return build;
  }

  /**
   * Cross-instance dedup wrapper: acquires the Firestore baseline lock (when
   * configured) so a burst of PR events across Cloud Run instances pays for
   * the expensive tarball + summarization build only once. Waiters reuse the
   * winner's stored context; on lock timeout we build anyway (correctness
   * over dedup).
   */
  private async doBuildAndSaveBaselineContext(
    params: BaselineBuildParams,
  ): Promise<string> {
    const lock = this.baselineLockRepository;
    if (!lock) {
      return this.buildBaselineNow(params);
    }

    let acquired = await lock.tryAcquire(params.baselineKey, this.lockOwner);
    if (!acquired) {
      params.logger?.info(
        `[Core] Baseline build for ${params.baselineKey} is locked by another instance; waiting for its context.`,
      );
      const outcome = await this.awaitBaselineSlot(params.baselineKey, lock);
      if (outcome && typeof outcome === 'object') {
        params.logger?.info(
          `[Core] Baseline context for ${params.baselineKey} became available while waiting; reusing it.`,
        );
        return outcome.summary;
      }
      acquired = outcome === 'acquire';
      if (!acquired) {
        params.logger?.warn(
          `[Core] Timed out waiting for the baseline lock on ${params.baselineKey}; building anyway.`,
        );
      }
    }

    try {
      return await this.buildBaselineNow(params);
    } finally {
      if (acquired) {
        await lock.release(params.baselineKey, this.lockOwner);
      }
    }
  }

  /**
   * Waits for another instance's baseline build. Resolves with the stored
   * summary once it appears, `'acquire'` when this instance took over the
   * (expired) lock, or null after the wait budget — the caller then builds
   * anyway.
   */
  private async awaitBaselineSlot(
    baselineKey: string,
    lock: BaselineLockRepository,
  ): Promise<{ summary: string } | 'acquire' | null> {
    const deadline = Date.now() + BASELINE_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, BASELINE_LOCK_POLL_MS),
      );
      const stored = await this.contextRepository.getContext(baselineKey);
      const storedSummary = stored?.summary;
      if (this.isValidSummary(storedSummary)) {
        return { summary: storedSummary };
      }
      if (await lock.tryAcquire(baselineKey, this.lockOwner)) {
        return 'acquire';
      }
    }
    return null;
  }

  private async buildBaselineNow(params: BaselineBuildParams): Promise<string> {
    params.logger?.info(
      `[Core] No baseline context found for ${params.baselineKey}. Building context in-process.`,
    );
    await this.prRepository.updatePRStatus(params.prKey, {
      provider: params.provider,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      status: 'queued',
      diff: params.diff,
      changedFiles: params.changedFiles,
      prMeta: {
        title: params.meta.title,
        author: params.meta.author,
        branch: params.meta.branch,
        body: params.meta.body,
      },
    });

    const sections = await this.agentService.buildContext({
      provider: params.provider,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      cloneUrl:
        params.meta.cloneUrl ||
        `https://github.com/${params.owner}/${params.repo}.git`,
      ref: params.meta.baseRef || 'main',
      isIncrementalUpdate: false,
      llm: this.llm,
      summaryLlm: this.summaryLlm,
      contextLoader: this.createContextLoader(),
      gitAdapter: this.gitAdapterClient,
    });

    const summary =
      typeof sections === 'string' ? sections : JSON.stringify(sections);

    if (this.isValidSummary(summary)) {
      await this.contextRepository.saveContext(params.baselineKey, { summary });
    } else {
      params.logger?.warn(
        `[Core] Baseline context generation returned empty for ${params.baselineKey}. Skipping save to prevent cache poisoning.`,
      );
    }
    return summary;
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
