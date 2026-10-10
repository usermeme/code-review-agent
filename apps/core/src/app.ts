import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { PubSub } from '@google-cloud/pubsub';
import { FirestoreDatabaseService } from './modules/database/firestore.service.js';
import { DatabaseService } from './modules/database/interfaces/database.interface.js';
import { PrRepository } from './modules/database/repositories/pr.repository.js';
import { ContextRepository } from './modules/database/repositories/context.repository.js';
import { AgentService } from './services/agent.service.js';
import { EventOrchestratorService } from './services/event-orchestrator.service.js';
import { healthModule } from './modules/health/health.module.js';
import { contextModule } from './modules/context/context.module.js';
import { PrEventsConsumer } from './modules/pubsub/pr-events.consumer.js';
import type { CoreEnvService } from './env.js';

export interface BuildCoreServerOptions {
  envService: CoreEnvService;
  pubsub: PubSub;
  databaseService?: DatabaseService;
  prRepository?: PrRepository;
  contextRepository?: ContextRepository;
  agentService?: AgentService;
  orchestrator?: EventOrchestratorService;
  prEventsConsumer?: PrEventsConsumer;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildCoreServer(
  options: BuildCoreServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  const databaseService =
    options.databaseService ?? new FirestoreDatabaseService();
  await databaseService.connect(server.log);

  const prRepository =
    options.prRepository ?? new PrRepository(databaseService);
  const contextRepository =
    options.contextRepository ?? new ContextRepository(databaseService);
  const agentService = options.agentService ?? new AgentService();

  const orchestrator =
    options.orchestrator ??
    new EventOrchestratorService({
      envService: options.envService,
      pubsub: options.pubsub,
      prRepository,
      contextRepository,
      agentService,
    });

  // 1. Health check module
  await server.register(healthModule);

  // 2. Context lookup module
  await server.register(contextModule, {
    prefix: '/api/v1/context',
    contextRepository,
  });

  // 3. Pub/Sub PR Events Consumer lifecycle (Nest-style onReady / onClose)
  const subscriptionName = options.envService.get('PR_EVENTS_SUBSCRIPTION');
  const consumer =
    options.prEventsConsumer ??
    new PrEventsConsumer({
      pubsub: options.pubsub,
      subscriptionName,
      orchestrator,
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
