import { FastifyBaseLogger } from 'fastify';
import { PubSub } from '@google-cloud/pubsub';
import { PrRepository } from '../database/repositories/pr.repository.js';

export interface ContextReadyPayload {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
}

export class InternalService {
  private pubsub: PubSub;

  constructor(private prRepository: PrRepository) {
    this.pubsub = new PubSub();
  }

  async handleContextReady(payload: ContextReadyPayload, logger: FastifyBaseLogger): Promise<void> {
    const { provider, owner, repo, prNumber } = payload;
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;

    logger.info(`Context is ready for PR: ${prKey}`);

    // Update state to "reviewing"
    await this.prRepository.updatePRStatus(prKey, {
      status: 'reviewing',
    });

    // Publish to the Review Code topic to wake up the Review Agent
    const topicName = process.env.REVIEW_CODE_TOPIC || 'review-code-topic';
    await this.pubsub.topic(topicName).publishMessage({
      json: payload
    });

    logger.info(`Published to ${topicName} for PR: ${prKey}`);
  }
}
