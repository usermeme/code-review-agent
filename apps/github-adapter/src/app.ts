import { PubSub } from '@google-cloud/pubsub';
import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';

import type { AdapterEnvService } from './env.js';
import { providerRoutes } from './modules/api/provider.routes.js';
import { GithubService } from './modules/github/github.service.js';
import { healthModule } from './modules/health/health.module.js';
import { pubsubModule } from './modules/pubsub/pubsub.module.js';

export interface BuildServerOptions {
  envService: AdapterEnvService;
  pubsub?: PubSub;
  githubService?: GithubService;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildServer(
  options: BuildServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  const githubService =
    options.githubService ??
    new GithubService({
      envService: options.envService,
    });

  // 1. Health check module
  await server.register(healthModule);

  // 2. Provider REST API module for on-demand tools (diff, search, files)
  await server.register(providerRoutes, {
    prefix: '/api/v1',
    githubService,
  });

  // 3. Pub/Sub Review Results Push route module
  await server.register(pubsubModule, {
    prefix: '/api/v1/pubsub',
    githubService,
  });

  return server;
}
