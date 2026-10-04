import { FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './health.routes.js';

export const healthModule: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoutes);
};
