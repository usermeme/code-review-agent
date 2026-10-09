import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import { ContextRepository } from '../modules/database/repositories/context.repository.js';
import { IngestPREventRequest, IngestPREventResponse } from 'contracts';
import {
  ContextReadyPayload,
  ReviewResultPayload,
  PREventPayload,
} from 'shared-types';
import type { CoreEnvService } from '../env.js';

export interface EventOrchestratorDependencies {
  envService: CoreEnvService;
  prRepository: PrRepository;
  contextRepository: ContextRepository;
  pubsub?: PubSub;
}

export class EventOrchestratorService {
  private pubsub: PubSub;
  private prRepository: PrRepository;
  private contextRepository: ContextRepository;
  private envService: CoreEnvService;

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub ?? new PubSub();
    this.prRepository = deps.prRepository;
    this.contextRepository = deps.contextRepository;
    this.envService = deps.envService;
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
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;
    const baselineKey = `${provider}:${owner}:${repo}:0`;

    logger?.info(`[Core] Ingesting PR event: ${action} for ${prKey}`);

    // If PR is merged, trigger incremental context update
    if (action === 'closed' && meta.isIncrementalUpdate) {
      logger?.info(
        `[Core] PR merged event for ${prKey}. Triggering incremental context build.`,
      );
      await this.publishContextBuild({
        provider,
        owner,
        repo,
        prNumber,
        action: 'merged',
        htmlUrl: meta.htmlUrl,
        cloneUrl: meta.cloneUrl,
        ref: meta.baseRef,
        isIncrementalUpdate: true,
      });

      return {
        success: true,
        status: 'queued',
        message: 'Incremental context build triggered for merged PR',
      } as IngestPREventResponse;
    }

    if (
      action === 'opened' ||
      action === 'synchronize' ||
      action === 'reopened' ||
      action === 'review_requested' ||
      action === 'manual_trigger'
    ) {
      // Check if baseline context exists in Firestore
      const baselineContext =
        await this.contextRepository.getContext(baselineKey);

      if (baselineContext) {
        logger?.info(
          `[Core] Baseline context found for ${baselineKey}. Triggering review directly.`,
        );
        await this.prRepository.updatePRStatus(prKey, {
          provider,
          owner,
          repo,
          prNumber,
          status: 'reviewing',
          diff: req.diff,
          changedFiles: req.changedFiles,
        });

        await this.publishReviewCode({
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
          diff: req.diff,
          changedFiles: req.changedFiles.join('\n'),
          baselineContext: baselineContext.summary,
        });

        return {
          success: true,
          status: 'reviewing',
          message: 'Review triggered directly with existing baseline context',
        } as IngestPREventResponse;
      }

      // No baseline context found. Save pending PR info and trigger full context build
      logger?.info(
        `[Core] No baseline context found for ${baselineKey}. Queuing PR and building context.`,
      );
      await this.prRepository.updatePRStatus(prKey, {
        provider,
        owner,
        repo,
        prNumber,
        status: 'queued',
        diff: req.diff,
        changedFiles: req.changedFiles,
        prMeta: {
          title: meta.title,
          author: meta.author,
          branch: meta.branch,
          body: meta.body,
        },
      });

      await this.publishContextBuild({
        provider,
        owner,
        repo,
        prNumber,
        action,
        htmlUrl: meta.htmlUrl,
        cloneUrl: meta.cloneUrl || `https://github.com/${owner}/${repo}.git`,
        ref: meta.baseRef || 'main',
        isIncrementalUpdate: false,
      });

      return {
        success: true,
        status: 'queued',
        message: 'Context build triggered',
      } as IngestPREventResponse;
    }

    return {
      success: true,
      status: 'ignored',
      message: `Ignored action: ${action}`,
    } as IngestPREventResponse;
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

    // Context is ready for pending PR! Now trigger the review!
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;
    const pendingPR = await this.prRepository.getPRStatus(prKey);

    logger?.info(`[Core] Triggering code review for ${prKey}`);
    await this.prRepository.updatePRStatus(prKey, { status: 'reviewing' });

    await this.publishReviewCode({
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
      changedFiles: Array.isArray(pendingPR?.changedFiles)
        ? pendingPR.changedFiles.join('\n')
        : '',
      baselineContext: summary,
    });
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

  private async publishReviewResults(
    payload: ReviewResultPayload,
  ): Promise<void> {
    const topicName = this.envService.get('REVIEW_RESULTS_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });
  }

  private async publishContextBuild(data: Record<string, any>): Promise<void> {
    const topicName = this.envService.get('BUILD_CONTEXT_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: data,
    });
  }

  private async publishReviewCode(data: Record<string, any>): Promise<void> {
    const topicName = this.envService.get('REVIEW_CODE_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: data,
    });
  }
}
