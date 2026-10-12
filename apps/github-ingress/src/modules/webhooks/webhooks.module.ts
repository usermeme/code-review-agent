import { FastifyPluginAsync } from 'fastify';

import { GithubIngressService } from './ingress.service.js';
import { webhooksRoutes } from './webhooks.routes.js';

export interface WebhooksModuleOptions {
  ingressService: GithubIngressService;
}

export const webhooksModule: FastifyPluginAsync<WebhooksModuleOptions> = async (
  fastify,
  options,
) => {
  const { ingressService } = options;
  await fastify.register(webhooksRoutes, { ingressService });
};
