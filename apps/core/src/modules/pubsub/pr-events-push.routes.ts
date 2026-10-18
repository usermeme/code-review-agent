import {
  extractPushMessageId,
  parsePubSubPushPayload,
} from '@code-review-agent/pubsub';
import {
  NonRetryableTaskError,
  PREventPayload,
} from '@code-review-agent/shared-types';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { DeliveryRepository } from '../database/repositories/delivery.repository.js';

export interface PrEventsPushRoutesOptions {
  orchestrator: EventOrchestratorService;
  /** Optional cross-instance delivery dedup (Pub/Sub messageId / commit claims). */
  deliveryRepository?: DeliveryRepository;
}

/**
 * Resolves the deduplication claim key for a PR event delivery:
 * - When `headSha` is present on an automatic PR event, claims by
 *   `provider:owner:repo:prNumber@headSha` so simultaneous `opened` +
 *   `review_requested` webhooks for the same commit are deduplicated alongside
 *   Pub/Sub redeliveries.
 * - Falls back to the Pub/Sub `messageId` for `manual_trigger` (`/review`
 *   comments must be allowed to re-review the same commit) or when `headSha`
 *   is omitted.
 */
function resolveClaimKey(
  payload: PREventPayload,
  messageId: string | undefined,
): string | undefined {
  const {
    provider,
    owner,
    repo,
    prNumber,
    action,
    headSha,
    isIncrementalUpdate,
  } = payload.prMeta;
  if (headSha && action !== 'manual_trigger' && prNumber) {
    const kind = action === 'closed' && isIncrementalUpdate ? '#merged' : '';
    return `${provider || 'github'}:${owner}:${repo}:${prNumber}${kind}@${headSha}`;
  }
  return messageId;
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

    // Dedup: Pub/Sub redelivers the same messageId when an ack deadline is
    // exceeded, and GitHub often fires `opened` + `review_requested` for the
    // same commit SHA simultaneously.
    const messageId = extractPushMessageId(request.body);
    const claimKey = resolveClaimKey(payload, messageId);
    if (claimKey && options.deliveryRepository) {
      let claimed: boolean;
      try {
        claimed = await options.deliveryRepository.claim(claimKey);
      } catch (err) {
        // A dedup outage must not block reviews — proceed without a claim.
        request.log.warn(
          `[PrEventsPush] Delivery dedup unavailable, proceeding: ${String(err)}`,
        );
        claimed = true;
      }
      if (!claimed) {
        request.log.info(
          `[PrEventsPush] Skipping duplicate delivery ${claimKey}`,
        );
        return reply.status(200).send({
          success: false,
          reason: 'Duplicate delivery',
        });
      }
    }

    const releaseClaim = async () => {
      if (claimKey && options.deliveryRepository) {
        await options.deliveryRepository.release(claimKey);
      }
    };
    const settleClaim = async () => {
      if (claimKey && options.deliveryRepository) {
        await options.deliveryRepository
          .markDone(claimKey)
          .catch(() => undefined);
      }
    };

    try {
      request.log.info(
        `[PrEventsPush] Processing PR event for ${payload.prMeta.owner}/${payload.prMeta.repo} #${payload.prMeta.prNumber}`,
      );
      const res = await options.orchestrator.ingestPREvent(
        payload,
        request.log,
      );
      await settleClaim();
      return reply.status(200).send({
        success: true,
        data: res,
      });
    } catch (error) {
      if (error instanceof NonRetryableTaskError) {
        // Deterministic failure: redelivery repeats the same paid work and
        // fails identically. Ack, and rely on the recorded PR status (set by
        // the orchestrator) for observability.
        request.log.warn(
          `[PrEventsPush] Non-retryable failure, acking: ${error.message}`,
        );
        await settleClaim();
        return reply.status(200).send({
          success: false,
          reason: 'Non-retryable failure',
          error: error.message,
        });
      }
      request.log.error(
        `[PrEventsPush] Error processing PR event: ${String(error)}`,
      );
      // Release the claim so the Pub/Sub redelivery can retry.
      await releaseClaim();
      return reply.status(500).send({
        success: false,
        error: String(error),
      });
    }
  });
};
