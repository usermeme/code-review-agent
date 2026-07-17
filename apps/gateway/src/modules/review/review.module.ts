import { FastifyPluginAsync } from 'fastify';

export const reviewModule: FastifyPluginAsync = async (fastify) => {
  fastify.post('/review-results', async (request, reply) => {
    // TODO: Store results & format response, post to GitHub
    return { status: 'processed' };
  });
};
