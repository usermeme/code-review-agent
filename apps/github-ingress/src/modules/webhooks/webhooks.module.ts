import { FastifyPluginAsync } from 'fastify';
import { webhooksRoutes } from './webhooks.routes.js';
import { GithubIngressService } from './ingress.service.js';

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
