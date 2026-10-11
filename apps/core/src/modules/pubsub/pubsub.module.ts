import { FastifyPluginAsync } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { prEventsPushRoutes } from './pr-events-push.routes.js';

export interface PubSubModuleOptions {
  orchestrator: EventOrchestratorService;
}

export const pubsubModule: FastifyPluginAsync<PubSubModuleOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator } = options;
  await fastify.register(prEventsPushRoutes, { orchestrator });
};
