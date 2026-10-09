import { FastifyPluginAsync } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { ContextReadyPayload } from 'shared-types';
import type { CoreEnvService } from '../../env.js';

interface PubSubMessage {
  message: {
    data: string;
    messageId: string;
    attributes?: Record<string, string>;
  };
  subscription: string;
}

export interface InternalRoutesOptions {
  envService: CoreEnvService;
  orchestrator: EventOrchestratorService;
}

export const internalRoutes: FastifyPluginAsync<InternalRoutesOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator, envService } = options;

  // Context Ready Callback from Pub/Sub push subscription
  fastify.post('/pubsub', async (request, reply) => {
    const query = request.query as { token?: string };
    const expectedToken = envService.get('INTERNAL_AUTH_TOKEN');

    if (expectedToken && query.token !== expectedToken) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as PubSubMessage;
    if (!body || !body.message || !body.message.data) {
      return reply
        .code(400)
        .send({ error: 'Bad Request: Missing Pub/Sub message data' });
    }

    try {
      const decodedData = Buffer.from(body.message.data, 'base64').toString(
        'utf8',
      );
      const payload = JSON.parse(decodedData) as ContextReadyPayload;

      if (!payload.provider || !payload.owner || !payload.repo) {
        throw new Error('Invalid ContextReadyPayload structure');
      }

      await orchestrator.handleContextReady(payload, fastify.log);
      return reply.code(200).send({ status: 'ok' });
    } catch (error) {
      fastify.log.error(
        `Failed to process ContextReady Pub/Sub message: ${error}`,
      );
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
};
