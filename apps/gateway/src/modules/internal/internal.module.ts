import { FastifyPluginAsync } from 'fastify';
import { InternalService } from './internal.service.js';
import { internalRoutes } from './internal.routes.js';
import { PrRepository } from '../database/repositories/pr.repository.js';
import { ContextRepository } from '../database/repositories/context.repository.js';

export interface InternalModuleOptions {
  prRepository: PrRepository;
  contextRepository: ContextRepository;
}

export const internalModule: FastifyPluginAsync<InternalModuleOptions> = async (fastify, options) => {
  const { prRepository, contextRepository } = options;
  
  const internalService = new InternalService(prRepository, contextRepository);

  fastify.register(internalRoutes, { internalService });
};
