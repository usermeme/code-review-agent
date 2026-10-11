import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { PubSub } from '@google-cloud/pubsub';
import { GithubService } from './modules/github/github.service.js';
import { providerRoutes } from './modules/api/provider.routes.js';
import { pubsubModule } from './modules/pubsub/pubsub.module.js';
import { healthModule } from './modules/health/health.module.js';
import { ReviewResultsConsumer } from './modules/pubsub/review-results.consumer.js';
import type { AdapterEnvService } from './env.js';

export interface BuildServerOptions {
  envService: AdapterEnvService;
  pubsub: PubSub;
  githubService?: GithubService;
  reviewResultsConsumer?: ReviewResultsConsumer;
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

  // 4. Pub/Sub Pull Consumer
  const subscriptionName = options.envService.get(
    'REVIEW_RESULTS_SUBSCRIPTION',
  );
  const consumer =
    options.reviewResultsConsumer ??
    new ReviewResultsConsumer({
      pubsub: options.pubsub,
      subscriptionName,
      githubService,
      logger: server.log,
    });

  server.addHook('onReady', async () => {
    consumer.start();
  });

  server.addHook('onClose', async () => {
    await consumer.stop();
  });

  return server;
}
