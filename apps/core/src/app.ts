import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';

import { contextModule } from './modules/context/context.module.js';
import { DatabaseService } from './modules/database/interfaces/database.interface.js';
import { ContextRepository } from './modules/database/repositories/context.repository.js';
import { DeliveryRepository } from './modules/database/repositories/delivery.repository.js';
import { healthModule } from './modules/health/health.module.js';
import { pubsubModule } from './modules/pubsub/pubsub.module.js';
import { EventOrchestratorService } from './services/event-orchestrator.service.js';

export interface BuildCoreServerOptions {
  databaseService: DatabaseService;
  contextRepository: ContextRepository;
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

  // 1. Health check module
  await server.register(healthModule);

  // 2. Context lookup module
  await server.register(contextModule, {
    prefix: '/api/v1/context',
    contextRepository: options.contextRepository,
  });

  // 3. Pub/Sub PR Events Push route module (wakes up scale-to-zero serverless instances)
  await server.register(pubsubModule, {
    prefix: '/api/v1/pubsub',
    orchestrator: options.orchestrator,
    deliveryRepository: options.deliveryRepository,
  });

  return server;
}
