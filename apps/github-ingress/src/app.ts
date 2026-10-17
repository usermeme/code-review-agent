import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';

import { healthModule } from './modules/health/health.module.js';
import { GithubIngressService } from './modules/webhooks/ingress.service.js';
import { webhooksModule } from './modules/webhooks/webhooks.module.js';

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

  // 1. Health check module
  await server.register(healthModule);

  // 2. Webhook Ingress module
  await server.register(webhooksModule, {
    prefix: '/api/v1/webhooks',
    ingressService,
  });

  return server;
}
