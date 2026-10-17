import { prepareDiff } from '@code-review-agent/agent-code-reviewer';
import { LlmFactory } from '@code-review-agent/llm';
import {
  ContextReadyPayload,
  GitAdapterContract,
  PREventPayload,
  PRMeta,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';

import type { CoreEnvService } from '../env.js';
import { GitAdapterClient } from '../modules/adapter/git-adapter.client.js';
import { ContextRepository } from '../modules/database/repositories/context.repository.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import { ReviewRunRepository } from '../modules/database/repositories/review-run.repository.js';
import type { AgentService } from './agent.service.js';
import { isRetryableError } from './review-errors.js';

export interface PREventResult {
  success: boolean;
  status: 'queued' | 'reviewing' | 'ignored' | 'duplicate' | 'failed' | 'error';
  message: string;
}

/** Pub/Sub delivery metadata for the event being processed. */
export interface PREventDelivery {
  messageId?: string;
}

const REVIEW_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'review_requested',
  'manual_trigger',
]);

export interface EventOrchestratorDependencies {
  envService: CoreEnvService;
  prRepository: PrRepository;
  contextRepository: ContextRepository;
  reviewRunRepository: ReviewRunRepository;
  pubsub: PubSub;
  agentService: AgentService;
  gitAdapterClient?: GitAdapterContract;
  llm?: BaseLlm;
}

export class EventOrchestratorService {
  private pubsub: PubSub;
  private prRepository: PrRepository;
  private contextRepository: ContextRepository;
  private reviewRunRepository: ReviewRunRepository;
  private envService: CoreEnvService;
  private agentService: AgentService;
  private gitAdapterClient: GitAdapterContract;
  private llm: BaseLlm;

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub;
    this.prRepository = deps.prRepository;
    this.contextRepository = deps.contextRepository;
    this.reviewRunRepository = deps.reviewRunRepository;
    this.envService = deps.envService;
    this.agentService = deps.agentService;

    const adapterUrl = deps.envService.get('GIT_ADAPTER_URL');
    this.gitAdapterClient =
      deps.gitAdapterClient ?? new GitAdapterClient(adapterUrl);

    this.llm = deps.llm ?? new LlmFactory(deps.envService.data).createLlm();
  }

  /**
   * Processes a PR event at most once per revision. Redeliveries and
   * duplicate events are acknowledged without re-running the review; failures
   * are rethrown (so Pub/Sub redelivers) only when a retry can succeed.
   */
  async ingestPREvent(
    req: PREventPayload,
    logger?: FastifyBaseLogger,
    delivery: PREventDelivery = {},
  ): Promise<PREventResult> {
    const meta = req.prMeta;
    if (!meta) {
      return {
        success: false,
        status: 'error',
        message: 'Missing PR metadata',
      };
    }

    const { provider, owner, repo, prNumber } = meta;
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;
    const runKey = this.runKeyFor(req, prKey, delivery);

    if (runKey) {
      const lock = await this.reviewRunRepository.acquire(runKey);
      if ('reason' in lock) {
        logger?.info(
          `[Core] Skipping ${meta.action} for ${prKey}: run ${runKey} is ${lock.reason}.`,
        );
        return {
          success: true,
          status: 'duplicate',
          message: `Skipped: run ${lock.reason}`,
        };
      }
      logger?.info(`[Core] Run ${runKey} attempt ${lock.attempt}.`);
    }

    try {
      const response = await this.processPREvent(req, meta, logger);
      if (runKey) await this.reviewRunRepository.complete(runKey);
      return response;
    } catch (error) {
      const retryable = isRetryableError(error);
      logger?.error(
        `[Core] Processing ${meta.action} for ${prKey} failed (${retryable ? 'retryable' : 'permanent'}): ${String(error)}`,
      );
      if (runKey) {
        await this.reviewRunRepository.fail(runKey, String(error), retryable);
      }
      await this.prRepository.updatePRStatus(prKey, {
        status: 'failed',
        error: String(error),
      });
      if (retryable) throw error;
      return {
        success: false,
        status: 'failed',
        message: String(error),
      };
    }
  }

  /**
   * Identity of one unit of work, or undefined for events that do no
   * expensive work. Review events are keyed by head commit so `opened` and
   * `review_requested` for the same revision review once; a manual `/review`
   * is keyed by its message so it can deliberately re-review a revision.
   */
  private runKeyFor(
    req: PREventPayload,
    prKey: string,
    delivery: PREventDelivery,
  ): string | undefined {
    const meta = req.prMeta;
    if (!meta) return undefined;

    if (meta.action === 'closed' && meta.isIncrementalUpdate) {
      return `${prKey}#merged`;
    }
    if (!REVIEW_ACTIONS.has(meta.action)) return undefined;
    if (meta.action !== 'manual_trigger' && meta.headSha) {
      return `${prKey}@${meta.headSha}`;
    }
    return delivery.messageId
      ? `${prKey}#msg-${delivery.messageId}`
      : undefined;
  }

  private async processPREvent(
    req: PREventPayload,
    meta: PRMeta,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
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

    if (REVIEW_ACTIONS.has(action)) {
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

      const isValidContext =
        existingContext?.summary &&
        existingContext.summary.trim() !== '' &&
        existingContext.summary.trim() !== '{}' &&
        existingContext.summary.trim() !== '{"summary":""}';

      const baselineSummary =
        (isValidContext ? existingContext.summary : null) ??
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

      const reviewResult = await this.agentService.runReview(
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
          },
          diff,
          changedFiles: changedFilesStr,
          tickets: [],
        },
        {
          llm: this.llm,
          baselineContext: baselineSummary,
          gitAdapter: this.gitAdapterClient,
        },
      );

      await this.handleReviewResults(reviewResult, logger);

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

    const reviewResult = await this.agentService.runReview(
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
        },
        diff: pendingPR?.diff || '',
        changedFiles: changedFilesStr,
        tickets: [],
      },
      {
        llm: this.llm,
        baselineContext: summary,
        gitAdapter: this.gitAdapterClient,
      },
    );

    await this.handleReviewResults(reviewResult, logger);
  }

  async handleReviewResults(
    payload: ReviewResultPayload,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const { provider, owner, repo, prNumber, summary } = payload;
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;

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

  private async buildAndSaveBaselineContext(params: {
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
  }): Promise<string> {
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
      gitAdapter: this.gitAdapterClient,
    });

    const summary =
      typeof sections === 'string' ? sections : JSON.stringify(sections);
    const isValid =
      summary &&
      summary.trim() !== '' &&
      summary.trim() !== '{}' &&
      summary.trim() !== '{"summary":""}';

    if (isValid) {
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
