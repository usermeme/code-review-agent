import { FastifyPluginAsync } from 'fastify';

export const webhooksModule: FastifyPluginAsync = async (fastify) => {
  fastify.post('/webhook', async (request, reply) => {
    // TODO: Implement webhook ingestion and DB check
    return { status: 'received' };
  });
};
