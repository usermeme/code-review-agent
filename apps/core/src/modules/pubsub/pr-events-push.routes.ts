import { parsePubSubPushPayload } from '@code-review-agent/pubsub';
import { PREventPayload } from '@code-review-agent/shared-types';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';

export interface PrEventsPushRoutesOptions {
  orchestrator: EventOrchestratorService;
}

export const prEventsPushRoutes: FastifyPluginAsync<
  PrEventsPushRoutesOptions
> = async (fastify: FastifyInstance, options: PrEventsPushRoutesOptions) => {
  fastify.post('/pr-events', async (request, reply) => {
    let payload: PREventPayload;
    try {
      payload = parsePubSubPushPayload<PREventPayload>(request.body);
    } catch (err) {
      request.log.warn(
        `[PrEventsPush] Malformed Pub/Sub envelope: ${String(err)}`,
      );
      return reply.status(200).send({
        success: false,
        reason: 'Malformed Pub/Sub envelope',
      });
    }

    if (!payload?.prMeta?.owner || !payload?.prMeta?.repo) {
      request.log.warn(
        '[PrEventsPush] Invalid payload structure in push message',
      );
      return reply.status(200).send({
        success: false,
        reason: 'Invalid payload structure',
      });
    }

    try {
      request.log.info(
        `[PrEventsPush] Processing PR event for ${payload.prMeta.owner}/${payload.prMeta.repo} #${payload.prMeta.prNumber}`,
      );
      const res = await options.orchestrator.ingestPREvent(
        payload,
        request.log,
      );
      return reply.status(200).send({
        success: true,
        data: res,
      });
    } catch (error) {
      request.log.error(
        `[PrEventsPush] Error processing PR event: ${String(error)}`,
      );
      return reply.status(500).send({
        success: false,
        error: String(error),
      });
    }
  });
};
