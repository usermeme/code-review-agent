import { FastifyPluginAsync } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { internalRoutes } from './internal.routes.js';
import type { CoreEnvService } from '../../env.js';

export interface InternalModuleOptions {
  envService: CoreEnvService;
  orchestrator: EventOrchestratorService;
}

export const internalModule: FastifyPluginAsync<InternalModuleOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator, envService } = options;
  await fastify.register(internalRoutes, { orchestrator, envService });
};
