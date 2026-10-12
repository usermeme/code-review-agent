import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { healthRoutes } from './health.routes.js';

export const healthModule: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(healthRoutes);
});
