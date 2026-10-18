import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';

import { providerRoutes } from './modules/api/provider.routes.js';
import { GithubService } from './modules/github/github.service.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { reviewResultsPushRoutes } from './modules/pubsub/review-results-push.routes.js';

export interface BuildServerOptions {
  githubService: GithubService;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildServer(
  options: BuildServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  const { githubService } = options;

  // 1. Health check routes
  await server.register(healthRoutes);

  // 2. Provider REST API routes for on-demand tools (diff, search, files)
  await server.register(providerRoutes, {
    prefix: '/api/v1',
    githubService,
  });

  // 3. Pub/Sub Review Results Push route
  await server.register(reviewResultsPushRoutes, {
    prefix: '/api/v1/pubsub',
    githubService,
  });

  return server;
}
