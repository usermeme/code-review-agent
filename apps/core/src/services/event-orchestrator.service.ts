import { ReviewNotSubmittedError } from '@code-review-agent/agent-code-reviewer';
import {
  IngestPREventRequest,
  IngestPREventResponse,
} from '@code-review-agent/contracts';
import {
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
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import type { AgentRunner } from './agent.service.js';

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
  pubsub: PubSub;
  agentService: AgentRunner;
  gitAdapterClient?: GitAdapterContract;
}

export class EventOrchestratorService {
  private pubsub: PubSub;
  private prRepository: PrRepository;
  private contextRepository: ContextRepository;
  private envService: CoreEnvService;
  private agentService: AgentRunner;
  private gitAdapterClient: GitAdapterContract;

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub;
    this.prRepository = deps.prRepository;
    this.contextRepository = deps.contextRepository;
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
      await this.applyMergedPr(repoRef, prNumber, logger);
      return {
        success: true,
        status: 'queued',
        message: 'Merged PR processed for incremental context update',
      } as IngestPREventResponse;
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

      const context =
        (await this.contextRepository.get(toRepoKey(repoRef))) ??
        (await this.buildBaseline(repoRef, meta.baseRef, logger));

      return this.reviewPullRequest(
        {
          repoRef,
          prNumber,
          meta,
          diff,
          changedFiles: Array.isArray(changedFiles) ? changedFiles : [],
        },
        context,
        logger,
      );
    }

    return {
      success: true,
      status: 'ignored',
      message: `Ignored action: ${action}`,
    } as IngestPREventResponse;
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

  private async reviewPullRequest(
    pr: PullRequestToReview,
    context: RepoContext | null,
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

  /**
   * Folds a merged PR into the repo's baseline. Without a baseline there is
   * nothing to merge into — the next reviewed PR builds a full one — so the
   * update is skipped rather than writing a context built from the PR alone.
   */
  private async applyMergedPr(
    repoRef: RepoRef,
    prNumber: number,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const repoKey = toRepoKey(repoRef);
    const existing = await this.contextRepository.get(repoKey);
    if (!existing) {
      logger?.info(
        `[Core] No baseline context for ${repoKey}; skipping incremental update for merged PR #${prNumber}.`,
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

  private async buildBaseline(
    repoRef: RepoRef,
    ref: string | undefined,
    logger?: FastifyBaseLogger,
  ): Promise<RepoContext> {
    const repoKey = toRepoKey(repoRef);
    logger?.info(`[Core] No baseline context for ${repoKey}; building it.`);
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

  private async publishReviewResults(
    payload: ReviewResultPayload,
  ): Promise<void> {
    const topicName = this.envService.get('REVIEW_RESULTS_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });
  }
}
