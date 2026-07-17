import { FastifyPluginAsync } from 'fastify';

export const contextModule: FastifyPluginAsync = async (fastify) => {
  fastify.get('/context', async (request, reply) => {
    return { context: {} };
  });
};
