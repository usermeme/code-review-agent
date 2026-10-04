import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { FirestoreDatabaseService } from './modules/database/firestore.service.js';
import { DatabaseService } from './modules/database/interfaces/database.interface.js';
import { PrRepository } from './modules/database/repositories/pr.repository.js';
import { ContextRepository } from './modules/database/repositories/context.repository.js';
import { EventOrchestratorService } from './services/event-orchestrator.service.js';
import { healthModule } from './modules/health/health.module.js';
import { contextModule } from './modules/context/context.module.js';
import { reviewModule } from './modules/review/review.module.js';
import { internalModule } from './modules/internal/internal.module.js';
import { coreRpcRoutes } from './rpc/core.routes.js';
import { createClient, Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import type { CoreEnvService } from './env.js';
import { GatewayService, createAuthClientInterceptor } from 'contracts';

export interface BuildCoreServerOptions {
  envService: CoreEnvService;
  databaseService?: DatabaseService;
  prRepository?: PrRepository;
  contextRepository?: ContextRepository;
  gatewayClient?: Client<typeof GatewayService>;
  orchestrator?: EventOrchestratorService;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildCoreServer(
  options: BuildCoreServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  const databaseService = options.databaseService ?? new FirestoreDatabaseService();
  await databaseService.connect(server.log);

  const prRepository = options.prRepository ?? new PrRepository(databaseService);
  const contextRepository = options.contextRepository ?? new ContextRepository(databaseService);

  let gatewayClient = options.gatewayClient;
  if (!gatewayClient) {
    const gatewayUrl = options.envService.get('GATEWAY_URL');
    const transport = createConnectTransport({
      baseUrl: gatewayUrl,
      httpVersion: '1.1',
      interceptors: [createAuthClientInterceptor({})],
    });
    gatewayClient = createClient(GatewayService, transport);
  }

  const orchestrator =
    options.orchestrator ??
    new EventOrchestratorService({
      prRepository,
      contextRepository,
      gatewayClient,
      envService: options.envService,
    });

  // 1. Health check module
  await server.register(healthModule);

  // 2. ConnectRPC service module
  await server.register(coreRpcRoutes, { orchestrator });

  // 3. Internal PubSub callbacks module
  await server.register(internalModule, {
    prefix: '/api/v1/internal',
    orchestrator,
    contextRepository,
    envService: options.envService,
  });

  // 4. Context lookup module
  await server.register(contextModule, {
    prefix: '/api/v1/context',
    contextRepository,
  });

  // 5. Review results module
  await server.register(reviewModule, {
    prefix: '/api/v1/review',
    orchestrator,
    envService: options.envService,
  });

  return server;
}
