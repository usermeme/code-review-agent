import {
  GitAdapterContract,
  PREventPayload,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';

import type { CoreEnvService } from '../env.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';

export interface PREventResult {
  success: boolean;
  status: 'queued' | 'reviewing' | 'ignored' | 'error';
  message: string;
}

export interface EventOrchestratorDependencies {
  envService: CoreEnvService;
  prRepository: PrRepository;
  pubsub: PubSub;
  gitAdapterClient: GitAdapterContract;
  llm: BaseLlm;
}

const REVIEW_ACTIONS = [
  'opened',
  'synchronize',
  'reopened',
  'review_requested',
  'manual_trigger',
];

function isReviewableAction(action: string): boolean {
  return REVIEW_ACTIONS.includes(action);
}

export class EventOrchestratorService {
  private readonly pubsub: PubSub;
  private readonly prRepository: PrRepository;
  private readonly envService: CoreEnvService;
  private readonly gitAdapterClient: GitAdapterContract;
  private readonly llm: BaseLlm;

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub;
    this.prRepository = deps.prRepository;
    this.envService = deps.envService;
    this.gitAdapterClient = deps.gitAdapterClient;
    this.llm = deps.llm;
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

    logger?.info(`[Core] Ingesting PR event: ${action} for ${prKey}`);

    if (!isReviewableAction(action)) {
      return {
        success: true,
        status: 'ignored',
        message: `Ignored action: ${action}`,
      };
    }

    await this.prRepository.updatePRStatus(prKey, {
      provider,
      owner,
      repo,
      prNumber,
      status: 'queued',
    });

    return {
      success: true,
      status: 'queued',
      message: 'PR event queued',
    };
  }

  async publishReviewResults(payload: ReviewResultPayload): Promise<void> {
    const topicName = this.envService.get('REVIEW_RESULTS_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });
  }
}
