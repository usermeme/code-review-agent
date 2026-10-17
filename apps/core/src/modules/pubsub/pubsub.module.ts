import { FastifyPluginAsync } from 'fastify';

import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { DeliveryRepository } from '../database/repositories/delivery.repository.js';
import { prEventsPushRoutes } from './pr-events-push.routes.js';

export interface PubSubModuleOptions {
  orchestrator: EventOrchestratorService;
  deliveryRepository?: DeliveryRepository;
}

export const pubsubModule: FastifyPluginAsync<PubSubModuleOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator, deliveryRepository } = options;
  await fastify.register(prEventsPushRoutes, {
    orchestrator,
    deliveryRepository,
  });
};
