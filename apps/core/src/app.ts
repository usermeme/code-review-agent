import { LlmFactory } from '@code-review-agent/llm';
import { PubSub } from '@google-cloud/pubsub';
import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';

import type { CoreEnvService } from './env.js';
import { GitAdapterClient } from './modules/adapter/git-adapter.client.js';
import { contextModule } from './modules/context/context.module.js';
import { FirestoreDatabaseService } from './modules/database/firestore.service.js';
import { DatabaseService } from './modules/database/interfaces/database.interface.js';
import { ContextRepository } from './modules/database/repositories/context.repository.js';
import { LeaseRepository } from './modules/database/repositories/lease.repository.js';
import { PrRepository } from './modules/database/repositories/pr.repository.js';
import { healthModule } from './modules/health/health.module.js';
import { pubsubModule } from './modules/pubsub/pubsub.module.js';
import { AgentService } from './services/agent.service.js';
import { EventOrchestratorService } from './services/event-orchestrator.service.js';

export interface BuildCoreServerOptions {
  envService: CoreEnvService;
  pubsub: PubSub;
  databaseService?: DatabaseService;
  prRepository?: PrRepository;
  contextRepository?: ContextRepository;
  agentService?: AgentService;
  orchestrator?: EventOrchestratorService;
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
  const gitAdapterClient = new GitAdapterClient(
    options.envService.get('GIT_ADAPTER_URL'),
  );
  const agentService =
    options.agentService ??
    new AgentService({
      llm: new LlmFactory(options.envService.data).createLlm(),
      gitAdapter: gitAdapterClient,
    });

  const orchestrator =
    options.orchestrator ??
    new EventOrchestratorService({
      envService: options.envService,
      pubsub: options.pubsub,
      prRepository,
      contextRepository,
      leaseRepository: new LeaseRepository(databaseService),
      agentService,
      gitAdapterClient,
    });

  // 1. Health check module
  await server.register(healthModule);

  // 2. Context lookup module
  await server.register(contextModule, {
    prefix: '/api/v1/context',
    contextRepository,
  });

  // 3. Pub/Sub PR Events Push route module (wakes up scale-to-zero serverless instances)
  await server.register(pubsubModule, {
    prefix: '/api/v1/pubsub',
    orchestrator,
  });

  return server;
}
