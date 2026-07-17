import { FastifyPluginAsync } from 'fastify';

export const contextModule: FastifyPluginAsync = async (fastify) => {
  fastify.get('/context', async (request, reply) => {
    // TODO: Fetch repository context from DB
    return { context: {} };
  });
};
