import { FastifyPluginAsync } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { reviewRoutes } from './review.routes.js';
import type { CoreEnvService } from '../../env.js';

export interface ReviewModuleOptions {
  envService: CoreEnvService;
  orchestrator: EventOrchestratorService;
}

export const reviewModule: FastifyPluginAsync<ReviewModuleOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator, envService } = options;
  await fastify.register(reviewRoutes, { orchestrator, envService });
};
