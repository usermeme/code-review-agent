import { FastifyPluginAsync } from 'fastify';

export const reviewModule: FastifyPluginAsync = async (fastify) => {
  fastify.post('/review-results', async (request, reply) => {
    return { status: 'processed' };
  });
};
