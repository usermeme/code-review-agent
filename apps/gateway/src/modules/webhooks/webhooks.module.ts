import { FastifyPluginAsync } from 'fastify';
import { WebhooksService } from './webhooks.service.js';
import { webhooksRoutes } from './webhooks.routes.js';
import { GithubAdapter } from './adapters/github.adapter.js';
import { DatabaseService } from '../database/interfaces/database.interface.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface WebhooksModuleOptions {
  databaseService: DatabaseService;
}

export const webhooksModule: FastifyPluginAsync<WebhooksModuleOptions> = async (fastify, options) => {
  const { databaseService } = options;
  const githubAdapter = new GithubAdapter(databaseService);
  const webhooksService = new WebhooksService([githubAdapter]);
  await webhooksService.init(fastify.log);

  fastify.register(webhooksRoutes, { webhooksService });
};
