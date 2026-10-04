import { FastifyPluginAsync } from 'fastify';
import { ContextRepository } from '../database/repositories/context.repository.js';
import { contextRoutes } from './context.routes.js';

export interface ContextModuleOptions {
  contextRepository: ContextRepository;
}

export const contextModule: FastifyPluginAsync<ContextModuleOptions> = async (
  fastify,
  options,
) => {
  const { contextRepository } = options;
  await fastify.register(contextRoutes, { contextRepository });
};
