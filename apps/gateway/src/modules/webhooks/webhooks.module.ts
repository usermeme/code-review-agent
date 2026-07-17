import { FastifyPluginAsync } from 'fastify';
import { WebhooksService } from './webhooks.service.js';
import { webhooksRoutes } from './webhooks.routes.js';

// Extend the FastifyRequest interface to include rawBody
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export const webhooksModule: FastifyPluginAsync = async (fastify) => {
  // Initialize the Webhooks Service
  const webhooksService = new WebhooksService();
  await webhooksService.init(fastify.log);

  // Register the routes, passing the injected service
  fastify.register(webhooksRoutes, { webhooksService });
};
