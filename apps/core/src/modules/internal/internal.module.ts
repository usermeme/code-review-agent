import { FastifyPluginAsync } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { ContextRepository } from '../database/repositories/context.repository.js';
import { internalRoutes } from './internal.routes.js';

export interface InternalModuleOptions {
  orchestrator: EventOrchestratorService;
  contextRepository: ContextRepository;
}

export const internalModule: FastifyPluginAsync<InternalModuleOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator, contextRepository } = options;
  await fastify.register(internalRoutes, { orchestrator, contextRepository });
};
