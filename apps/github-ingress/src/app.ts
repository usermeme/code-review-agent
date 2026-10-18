import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';

import { healthRoutes } from './modules/health/health.routes.js';
import { GithubIngressService } from './modules/webhooks/ingress.service.js';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes.js';

export interface BuildServerOptions {
  ingressService: GithubIngressService;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildServer(
  options: BuildServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  await server.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  const { ingressService } = options;

  // 1. Health check routes
  await server.register(healthRoutes);

  // 2. Webhook Ingress routes
  await server.register(webhooksRoutes, {
    prefix: '/api/v1/webhooks',
    ingressService,
  });

  return server;
}
