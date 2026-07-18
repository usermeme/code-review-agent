import { FastifyPluginAsync } from 'fastify';
import { InternalService } from './internal.service.js';
import { ContextReadyPayload } from 'shared-types';

interface PubSubMessage {
  message: {
    data: string;
    messageId: string;
    attributes?: Record<string, string>;
  };
  subscription: string;
}

export const internalRoutes: FastifyPluginAsync<{
  internalService: InternalService;
}> = async (fastify, options) => {
  const { internalService } = options;

  fastify.post('/pubsub', async (request, reply) => {
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

      if (
        !payload.provider ||
        !payload.owner ||
        !payload.repo ||
        !payload.prNumber
      ) {
        throw new Error('Invalid payload structure');
      }

      await internalService.handleContextReady(payload, fastify.log);

      return reply.code(200).send();
    } catch (error) {
      fastify.log.error(`Failed to process Pub/Sub message: ${error}`);
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
};
