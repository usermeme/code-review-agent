import { FastifyPluginAsync } from 'fastify';
import { WebhooksService } from './webhooks.service.js';
import { webhooksRoutes } from './webhooks.routes.js';
import { GitService } from '../git/git.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface WebhooksModuleOptions {
  gitService: GitService;
}

export const webhooksModule: FastifyPluginAsync<WebhooksModuleOptions> = async (
  fastify,
  options,
) => {
  const { gitService } = options;
  const webhooksService = new WebhooksService(gitService);

  // Note: GitService init is handled in main.ts so that all modules can use initialized adapters
  fastify.register(webhooksRoutes, { webhooksService });
};
