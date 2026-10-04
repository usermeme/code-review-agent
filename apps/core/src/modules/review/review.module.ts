import { FastifyPluginAsync } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { reviewRoutes } from './review.routes.js';

export interface ReviewModuleOptions {
  orchestrator: EventOrchestratorService;
}

export const reviewModule: FastifyPluginAsync<ReviewModuleOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator } = options;
  await fastify.register(reviewRoutes, { orchestrator });
};
