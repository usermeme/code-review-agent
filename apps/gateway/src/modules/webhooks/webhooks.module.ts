import { FastifyPluginAsync } from 'fastify';
import { WebhooksService } from './webhooks.service.js';
import { webhooksRoutes } from './webhooks.routes.js';
import { GithubAdapter } from './adapters/github.adapter.js';
import { PrRepository } from '../database/repositories/pr.repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface WebhooksModuleOptions {
  prRepository: PrRepository;
}

export const webhooksModule: FastifyPluginAsync<WebhooksModuleOptions> = async (
  fastify,
  options,
) => {
  const { prRepository } = options;
  const githubAdapter = new GithubAdapter(prRepository);
  const webhooksService = new WebhooksService([githubAdapter]);
  await webhooksService.init(fastify.log);

  fastify.register(webhooksRoutes, { webhooksService });
};
