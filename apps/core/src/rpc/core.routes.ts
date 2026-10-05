import { FastifyPluginAsync } from 'fastify';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import { ConnectRouter } from '@connectrpc/connect';
import { CoreService, createAuthInterceptor } from 'contracts';
import { EventOrchestratorService } from '../services/event-orchestrator.service.js';

import type { CoreEnvService } from '../env.js';

export interface CoreRpcPluginOptions {
  orchestrator: EventOrchestratorService;
  envService: CoreEnvService;
}

export const coreRpcRoutes: FastifyPluginAsync<CoreRpcPluginOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator, envService } = options;

  await fastify.register(fastifyConnectPlugin, {
    routes(router: ConnectRouter) {
      router.service(CoreService, {
        async ingestPREvent(req) {
          return await orchestrator.ingestPREvent(req, fastify.log);
        },
      });
    },
    interceptors: [
      createAuthInterceptor({ token: envService.get('INTERNAL_AUTH_TOKEN') }),
    ],
  });
};
