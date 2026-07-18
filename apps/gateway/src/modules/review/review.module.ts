import { FastifyPluginAsync } from 'fastify';
import { GitService } from '../git/git.service.js';
import { PrRepository } from '../database/repositories/pr.repository.js';
import { ReviewResultPayload } from 'shared-types';

export interface ReviewModuleOptions {
  prRepository: PrRepository;
  gitService: GitService;
}

interface PubSubMessage {
  message: {
    data: string;
    messageId: string;
    attributes?: Record<string, string>;
  };
  subscription: string;
}

export const reviewModule: FastifyPluginAsync<ReviewModuleOptions> = async (
  fastify,
  options,
) => {
  const { prRepository, gitService } = options;

  fastify.post('/results', async (request, reply) => {
    const body = request.body as PubSubMessage;

    if (!body || !body.message || !body.message.data) {
      return reply
        .code(400)
        .send({ error: 'Bad Request: Missing Pub/Sub message data' });
    }

    try {
      const decodedData = Buffer.from(body.message.data, 'base64').toString('utf8');
      const payload = JSON.parse(decodedData) as ReviewResultPayload;

      if (
        !payload.provider ||
        !payload.owner ||
        !payload.repo ||
        !payload.prNumber ||
        !payload.comments
      ) {
        return reply.code(400).send({ error: 'Invalid payload' });
      }

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
