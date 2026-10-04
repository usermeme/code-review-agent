import { FastifyPluginAsync } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import type { ReviewResultPayload } from 'shared-types';

export interface ReviewRoutesOptions {
  orchestrator: EventOrchestratorService;
}

interface PubSubMessage {
  message: {
    data: string;
    messageId: string;
    attributes?: Record<string, string>;
  };
  subscription: string;
}

export const reviewRoutes: FastifyPluginAsync<ReviewRoutesOptions> = async (
  fastify,
  options,
) => {
  const { orchestrator } = options;

  fastify.post('/results', async (request, reply) => {
    const query = request.query as { token?: string };
    const expectedToken = process.env['PUBSUB_SECRET_TOKEN'];

    if (!expectedToken || query.token !== expectedToken) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as PubSubMessage;
    if (!body || !body.message || !body.message.data) {
      return reply
        .code(400)
        .send({ error: 'Bad Request: Missing Pub/Sub message data' });
    }

    try {
      const decodedData = Buffer.from(body.message.data, 'base64').toString('utf8');
      const payload = JSON.parse(decodedData) as ReviewResultPayload;

      if (!payload.provider || !payload.owner || !payload.repo || !payload.prNumber) {
        return reply.code(400).send({ error: 'Invalid payload structure' });
      }

      await orchestrator.handleReviewResults(payload, fastify.log);
      return reply.code(200).send({ status: 'processed' });
    } catch (error) {
      fastify.log.error(`Failed to process ReviewResult Pub/Sub message: ${error}`);
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
};
