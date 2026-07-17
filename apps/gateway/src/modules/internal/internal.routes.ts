import { FastifyPluginAsync } from 'fastify';
import { InternalService, ContextReadyPayload } from './internal.service.js';

interface PubSubMessage {
  message: {
    data: string;
    messageId: string;
    attributes?: Record<string, string>;
  };
  subscription: string;
}

export const internalRoutes: FastifyPluginAsync<{ internalService: InternalService }> = async (fastify, options) => {
  const { internalService } = options;

  fastify.post('/pubsub', async (request, reply) => {
    // 1. Verify this is actually from Pub/Sub
    // (Optional: check authorization headers, tokens, or VPC origin)
    
    // 2. Extract the base64 payload
    const body = request.body as PubSubMessage;
    
    if (!body || !body.message || !body.message.data) {
      return reply.code(400).send({ error: 'Bad Request: Missing Pub/Sub message data' });
    }

    try {
      // Decode the base64 string
      const decodedData = Buffer.from(body.message.data, 'base64').toString('utf8');
      
      // Parse the JSON payload
      const payload = JSON.parse(decodedData) as ContextReadyPayload;

      // Ensure the payload has what we need
      if (!payload.provider || !payload.owner || !payload.repo || !payload.prNumber) {
        throw new Error('Invalid payload structure');
      }

      // Delegate to service
      await internalService.handleContextReady(payload, fastify.log);

      // Acknowledge the message so Pub/Sub doesn't retry
      return reply.code(200).send();
    } catch (error) {
      fastify.log.error(`Failed to process Pub/Sub message: ${error}`);
      // Returning 500 tells Pub/Sub to retry the message later
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
};
