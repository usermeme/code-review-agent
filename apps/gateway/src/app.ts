import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { FirestoreDatabaseService } from './modules/database/firestore.service.js';
import { DatabaseService } from './modules/database/interfaces/database.interface.js';
import { PrRepository } from './modules/database/repositories/pr.repository.js';
import { ContextRepository } from './modules/database/repositories/context.repository.js';
import { GitService, createDefaultGitService } from './modules/git/git.service.js';
import { webhooksModule } from './modules/webhooks/webhooks.module.js';
import { contextModule } from './modules/context/context.module.js';
import { reviewModule } from './modules/review/review.module.js';
import { internalModule } from './modules/internal/internal.module.js';

export interface BuildServerOptions {
  databaseService?: DatabaseService;
  gitService?: GitService;
  prRepository?: PrRepository;
  contextRepository?: ContextRepository;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  await server.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  const databaseService = options.databaseService ?? new FirestoreDatabaseService();
  await databaseService.connect(server.log);

  const prRepository = options.prRepository ?? new PrRepository(databaseService);
  const contextRepository = options.contextRepository ?? new ContextRepository(databaseService);
  const gitService = options.gitService ?? createDefaultGitService(prRepository, contextRepository);

  await gitService.initAdapters(server.log);

  await server.register(webhooksModule, {
    prefix: '/api/v1/webhooks',
    gitService,
  });

  await server.register(internalModule, {
    prefix: '/api/v1/internal',
    prRepository,
    contextRepository,
    gitService,
  });

  await server.register(contextModule, {
    prefix: '/api/v1/context',
    contextRepository,
  });

  await server.register(reviewModule, {
    prefix: '/api/v1/review',
    prRepository,
    gitService,
  });

  server.get('/healthz', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  return server;
}
