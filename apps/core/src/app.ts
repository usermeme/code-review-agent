import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';

import { DatabaseService } from './modules/database/interfaces/database.interface.js';
import { DeliveryRepository } from './modules/database/repositories/delivery.repository.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { prEventsPushRoutes } from './modules/pubsub/pr-events-push.routes.js';
import { EventOrchestratorService } from './services/event-orchestrator.service.js';

interface BuildCoreServerOptions {
  databaseService: DatabaseService;
  orchestrator: EventOrchestratorService;
  /** Optional cross-instance Pub/Sub delivery dedup. */
  deliveryRepository?: DeliveryRepository;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildCoreServer(
  options: BuildCoreServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  await options.databaseService.connect(server.log);

  // 1. Health check routes
  await server.register(healthRoutes);

  // 2. Pub/Sub PR Events Push route (wakes up scale-to-zero serverless instances)
  await server.register(prEventsPushRoutes, {
    prefix: '/api/v1/pubsub',
    orchestrator: options.orchestrator,
    deliveryRepository: options.deliveryRepository,
  });

  return server;
}
