import { FastifyPluginAsync } from 'fastify';
import { InternalService } from './internal.service.js';
import { internalRoutes } from './internal.routes.js';
import { PrRepository } from '../database/repositories/pr.repository.js';
import { ContextRepository } from '../database/repositories/context.repository.js';
import { GitService } from '../git/git.service.js';

export interface InternalModuleOptions {
  prRepository: PrRepository;
  contextRepository: ContextRepository;
  gitService: GitService;
}

export const internalModule: FastifyPluginAsync<InternalModuleOptions> = async (
  fastify,
  options,
) => {
  const { prRepository, contextRepository, gitService } = options;

  const internalService = new InternalService(prRepository, contextRepository, gitService);

  fastify.register(internalRoutes, { internalService });
};
