import { FastifyPluginAsync } from 'fastify';
import { GitService } from '../git/git.service.js';
import { PrRepository } from '../database/repositories/pr.repository.js';
import { ReviewResultPayload } from 'shared-types';

export interface ReviewModuleOptions {
  prRepository: PrRepository;
  gitService: GitService;
}

export const reviewModule: FastifyPluginAsync<ReviewModuleOptions> = async (
  fastify,
  options,
) => {
  const { prRepository, gitService } = options;

  fastify.post('/results', async (request, reply) => {
    const payload = request.body as ReviewResultPayload;

    if (
      !payload.provider ||
      !payload.owner ||
      !payload.repo ||
      !payload.prNumber ||
      !payload.comments
    ) {
      return reply.code(400).send({ error: 'Invalid payload' });
    }

    try {
      const adapter = gitService.getAdapter(payload.provider);

      if (adapter && adapter.postInlineComments) {
        await adapter.postInlineComments(
          payload.owner,
          payload.repo,
          payload.prNumber,
          payload.comments,
        );
      } else {
        fastify.log.warn(
          `No adapter or postInlineComments method found for provider: ${payload.provider}`,
        );
      }

      const prKey = `${payload.provider}:${payload.owner}:${payload.repo}:${payload.prNumber}`;
      await prRepository.updatePRStatus(prKey, { status: 'completed' });

      return reply.code(200).send({ status: 'processed' });
    } catch (error) {
      fastify.log.error(`Failed to post review results: ${error}`);
      return reply.code(500).send({ error: 'Failed to post review results' });
    }
  });
};
