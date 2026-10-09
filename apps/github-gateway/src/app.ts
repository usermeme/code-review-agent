import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { GithubService } from './modules/github/github.service.js';
import { webhooksModule } from './modules/webhooks/webhooks.module.js';
import { healthModule } from './modules/health/health.module.js';
import type { GatewayEnvService } from './env.js';

export interface BuildServerOptions {
  envService: GatewayEnvService;
  githubService: GithubService;
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

  // 1. Health check module
  await server.register(healthModule);

  // 2. Webhook Ingress module
  await server.register(webhooksModule, {
    prefix: '/api/v1/webhooks',
    githubService: options.githubService,
  });

  return server;
}
