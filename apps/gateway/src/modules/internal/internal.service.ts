import { FastifyBaseLogger } from 'fastify';
import { PubSub } from '@google-cloud/pubsub';
import { PrRepository } from '../database/repositories/pr.repository.js';
import { ContextRepository } from '../database/repositories/context.repository.js';
import { ContextReadyPayload } from 'shared-types';

export class InternalService {
  private pubsub: PubSub;

  constructor(
    private prRepository: PrRepository,
    private contextRepository: ContextRepository,
  ) {
    this.pubsub = new PubSub();
  }

  async handleContextReady(
    payload: ContextReadyPayload,
    logger: FastifyBaseLogger,
  ): Promise<void> {
    const { provider, owner, repo, prNumber, files, summary } = payload;
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;

    logger.info(`Context is ready for PR: ${prKey}`);

    await this.contextRepository.saveContext(prKey, {
      files,
      summary,
    });

    await this.prRepository.updatePRStatus(prKey, {
      status: 'reviewing',
    });

    const topicName = process.env.REVIEW_CODE_TOPIC || 'review-code-topic';
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });

    logger.info(`Published to ${topicName} for PR: ${prKey}`);
  }
}
