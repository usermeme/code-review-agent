import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { PubSub } from '@google-cloud/pubsub';
import { GithubService } from './modules/github/github.service.js';
import { webhooksModule } from './modules/webhooks/webhooks.module.js';
import { healthModule } from './modules/health/health.module.js';
import { pubsubModule } from './modules/pubsub/pubsub.module.js';
import { ReviewResultsConsumer } from './modules/pubsub/review-results.consumer.js';
import type { GatewayEnvService } from './env.js';

export interface BuildServerOptions {
  envService: GatewayEnvService;
  pubsub: PubSub;
  githubService?: GithubService;
  reviewResultsConsumer?: ReviewResultsConsumer;
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

  const githubService =
    options.githubService ??
    new GithubService({
      pubsub: options.pubsub,
      envService: options.envService,
    });

  // 1. Health check module
  await server.register(healthModule);

  // 2. Webhook Ingress module
  await server.register(webhooksModule, {
    prefix: '/api/v1/webhooks',
    githubService,
  });

  // 3. Pub/Sub Review Results Push route module (wakes up scale-to-zero serverless instances)
  await server.register(pubsubModule, {
    prefix: '/api/v1/pubsub',
    githubService,
  });

  // 4. Optional Pub/Sub Review Results Pull Consumer (for persistent / non-serverless environments)
  const subscriptionName = options.envService.get(
    'REVIEW_RESULTS_SUBSCRIPTION',
  );
  const consumer =
    options.reviewResultsConsumer ??
    (subscriptionName
      ? new ReviewResultsConsumer({
          pubsub: options.pubsub,
          subscriptionName,
          githubService,
          logger: server.log,
        })
      : undefined);

  if (consumer) {
    server.addHook('onReady', async () => {
      consumer.start();
    });

    server.addHook('onClose', async () => {
      await consumer.stop();
    });
  }

  return server;
}
