import { FastifyPluginAsync } from 'fastify';
import { GithubAdapter } from '../webhooks/adapters/github.adapter.js';
import { PrRepository } from '../database/repositories/pr.repository.js';

export interface ReviewResultPayload {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  comments: { path: string; position: number; body: string }[];
}

export interface ReviewModuleOptions {
  prRepository: PrRepository;
}

export const reviewModule: FastifyPluginAsync<ReviewModuleOptions> = async (fastify, options) => {
  const { prRepository } = options;
  // TODO: We should probably share the adapter instance, but for now we instantiate it
  const githubAdapter = new GithubAdapter(prRepository);

  fastify.post('/review-results', async (request, reply) => {
    const payload = request.body as ReviewResultPayload;

    if (!payload.provider || !payload.owner || !payload.repo || !payload.prNumber || !payload.comments) {
      return reply.code(400).send({ error: 'Invalid payload' });
    }

    try {
      if (payload.provider === 'github') {
        await githubAdapter.postInlineComments(payload.owner, payload.repo, payload.prNumber, payload.comments);
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
