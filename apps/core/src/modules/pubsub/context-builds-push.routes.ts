import { parsePubSubPushPayload } from '@code-review-agent/pubsub';
import type { ContextBuildRequest } from '@code-review-agent/shared-types';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  ContextBuildInProgressError,
  EventOrchestratorService,
} from '../../services/event-orchestrator.service.js';

const repoRefSchema = z.object({
  provider: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
});

const contextBuildRequestSchema = z.discriminatedUnion('mode', [
  repoRefSchema.extend({
    mode: z.literal('baseline'),
    ref: z.string().optional(),
    pendingPrNumber: z.number().int().positive().optional(),
  }),
  repoRefSchema.extend({
    mode: z.literal('incremental'),
    prNumber: z.number().int().positive(),
  }),
]) satisfies z.ZodType<ContextBuildRequest>;

export interface ContextBuildsPushRoutesOptions {
  orchestrator: EventOrchestratorService;
}

/**
 * Push endpoint for the context-build topic. Status codes drive Pub/Sub:
 * 2xx acks; 503 (another build holds the repo's lease) and 500 are redelivered
 * with the subscription's retry backoff, up to its dead-letter limit.
 */
export const contextBuildsPushRoutes: FastifyPluginAsync<
  ContextBuildsPushRoutesOptions
> = async (
  fastify: FastifyInstance,
  options: ContextBuildsPushRoutesOptions,
) => {
  fastify.post('/context-builds', async (request, reply) => {
    let parsed: ReturnType<typeof contextBuildRequestSchema.safeParse>;
    try {
      parsed = contextBuildRequestSchema.safeParse(
        parsePubSubPushPayload<unknown>(request.body),
      );
    } catch (err) {
      request.log.warn(
        `[ContextBuildsPush] Malformed Pub/Sub envelope: ${String(err)}`,
      );
      return reply
        .status(200)
        .send({ success: false, reason: 'Malformed envelope' });
    }
    if (!parsed.success) {
      // Redelivering an invalid message can't succeed; ack it.
      request.log.warn(
        `[ContextBuildsPush] Invalid context build request: ${parsed.error.message}`,
      );
      return reply
        .status(200)
        .send({ success: false, reason: 'Invalid payload' });
    }

    try {
      await options.orchestrator.handleContextBuildRequest(
        parsed.data,
        request.log,
      );
      return reply.status(200).send({ success: true });
    } catch (error) {
      if (error instanceof ContextBuildInProgressError) {
        request.log.info(
          `[ContextBuildsPush] ${error.message} Retrying later.`,
        );
        return reply.status(503).send({ success: false, retry: true });
      }
      request.log.error(
        `[ContextBuildsPush] Context build failed: ${String(error)}`,
      );
      return reply.status(500).send({ success: false, error: String(error) });
    }
  });
};
