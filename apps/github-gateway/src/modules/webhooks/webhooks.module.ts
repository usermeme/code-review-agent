import { FastifyPluginAsync } from 'fastify';
import { webhooksRoutes } from './webhooks.routes.js';
import { GithubService } from '../github/github.service.js';

export interface WebhooksModuleOptions {
  githubService: GithubService;
}

export const webhooksModule: FastifyPluginAsync<WebhooksModuleOptions> = async (
  fastify,
  options,
) => {
  const { githubService } = options;
  await fastify.register(webhooksRoutes, { githubService });
};
