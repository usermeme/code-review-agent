import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { ContextRepository } from './modules/database/repositories/context.repository.js';
import { healthModule } from './modules/health/health.module.js';
import { contextModule } from './modules/context/context.module.js';
import type { CoreEnvService } from './env.js';

export interface BuildCoreServerOptions {
  envService: CoreEnvService;
  contextRepository: ContextRepository;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildCoreServer(
  options: BuildCoreServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  // 1. Health check module
  await server.register(healthModule);

  // 2. Context lookup module
  await server.register(contextModule, {
    prefix: '/api/v1/context',
    contextRepository: options.contextRepository,
  });

  return server;
}
