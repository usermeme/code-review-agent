import { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/healthz', async () => {
    return {
      status: 'ok',
      service: 'core',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });
};
