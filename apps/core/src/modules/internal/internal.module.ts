import { FastifyPluginAsync } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { ContextRepository } from '../database/repositories/context.repository.js';
import { internalRoutes } from './internal.routes.js';
import { CoreEnvService } from '../../env.js';

export interface InternalModuleOptions {
  orchestrator: EventOrchestratorService;
  contextRepository: ContextRepository;
  envService?: CoreEnvService;
}

export const internalModule: FastifyPluginAsync<InternalModuleOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator, contextRepository, envService } = options;
  await fastify.register(internalRoutes, { orchestrator, contextRepository, envService });
};
