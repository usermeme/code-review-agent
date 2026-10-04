import { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/healthz', async () => {
    return {
      status: 'ok',
      service: 'github-gateway',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });
};
