import { FastifyBaseLogger } from 'fastify';
import { PubSub } from '@google-cloud/pubsub';
import { PrRepository } from '../database/repositories/pr.repository.js';
import { ContextRepository } from '../database/repositories/context.repository.js';
import { GitService } from '../git/git.service.js';
import { ContextReadyPayload } from 'shared-types';

export class InternalService {
  private pubsub: PubSub;

  constructor(
    private prRepository: PrRepository,
    private contextRepository: ContextRepository,
    private gitService: GitService,
  ) {
    this.pubsub = new PubSub();
  }

  async handleContextReady(
    payload: ContextReadyPayload,
    logger: FastifyBaseLogger,
  ): Promise<void> {
    const { provider, owner, repo, prNumber, files, summary } = payload;
    
    // We always save the generated context as the baseline context
    const baselineKey = `${provider}:${owner}:${repo}:0`;
    logger.info(`Context is ready. Saving to baseline: ${baselineKey}`);

    await this.contextRepository.saveContext(baselineKey, {
      files,
      summary,
    });

    if (prNumber === 0) {
      logger.info(`Baseline context updated for ${provider}:${owner}:${repo}`);
      return;
    }

    // Now trigger review for the PR that requested the context build!
    logger.info(`Baseline context ready. Triggering review for ${provider}:${owner}:${repo}#${prNumber}`);
    const adapter = this.gitService.getAdapter(provider);
    if (!adapter || !adapter.triggerReview) {
      logger.error(`Adapter for ${provider} does not support triggerReview!`);
      return;
    }
    
    await adapter.triggerReview(owner, repo, prNumber);
  }
}
