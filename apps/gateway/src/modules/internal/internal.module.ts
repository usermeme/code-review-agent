import { FastifyPluginAsync } from 'fastify';
import { InternalService } from './internal.service.js';
import { internalRoutes } from './internal.routes.js';
import { PrRepository } from '../database/repositories/pr.repository.js';

export interface InternalModuleOptions {
  prRepository: PrRepository;
}

export const internalModule: FastifyPluginAsync<InternalModuleOptions> = async (fastify, options) => {
  const { prRepository } = options;
  
  const internalService = new InternalService(prRepository);

  fastify.register(internalRoutes, { internalService });
};
