import {
  extractPushMessageId,
  parsePubSubPushPayload,
} from '@code-review-agent/pubsub';
import {
  NonRetryableTaskError,
  PREventPayload,
} from '@code-review-agent/shared-types';
import {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { DeliveryRepository } from '../database/repositories/delivery.repository.js';

export interface PrEventsPushRoutesOptions {
  orchestrator: EventOrchestratorService;
  /** Optional cross-instance delivery dedup (Pub/Sub messageId / commit claims). */
  deliveryRepository?: DeliveryRepository;
}

/** Ack body (200, no retry) with which a delivery is rejected or skipped. */
interface PushFailureResponse {
  success: false;
  reason: string;
}

type PushEnvelopeResult =
  | { payload: PREventPayload; failure?: undefined }
  | { payload?: undefined; failure: PushFailureResponse };

/**
 * Cross-instance dedup handle for one delivery. The inactive claim keeps the
 * route free of `claimKey && deliveryRepository` guards: it always acquires
 * and its release/settle are no-ops.
 */
interface DeliveryClaim {
  /** Key the delivery is claimed under; used in the duplicate-skip log. */
  key: string;
  acquire(logger: FastifyBaseLogger): Promise<boolean>;
  release(): Promise<void>;
  settle(): Promise<void>;
}

const INACTIVE_CLAIM: DeliveryClaim = {
  key: '',
  acquire: async () => true,
  release: async () => undefined,
  settle: async () => undefined,
};

/** Suffix distinguishing merged-PR claims from regular commit claims. */
function mergedClaimSuffix(
  action: string,
  isIncrementalUpdate: boolean | undefined,
): string {
  return action === 'closed' && isIncrementalUpdate ? '#merged' : '';
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
    const kind = mergedClaimSuffix(action, isIncrementalUpdate);
    return `${provider || 'github'}:${owner}:${repo}:${prNumber}${kind}@${headSha}`;
  }
  return messageId;
}

function hasPrCoordinates(payload: PREventPayload): boolean {
  const prMeta = payload?.prMeta;
  return Boolean(prMeta?.owner && prMeta?.repo);
}

/**
 * Parses and validates the Pub/Sub push envelope. On failure logs the same
 * warning the route used to and returns the ack body to send back.
 */
function parsePushEnvelope(
  body: unknown,
  logger: FastifyBaseLogger,
): PushEnvelopeResult {
  let payload: PREventPayload;
  try {
    payload = parsePubSubPushPayload<PREventPayload>(body);
  } catch (err) {
    logger.warn(`[PrEventsPush] Malformed Pub/Sub envelope: ${String(err)}`);
    return {
      failure: { success: false, reason: 'Malformed Pub/Sub envelope' },
    };
  }

  if (!hasPrCoordinates(payload)) {
    logger.warn('[PrEventsPush] Invalid payload structure in push message');
    return { failure: { success: false, reason: 'Invalid payload structure' } };
  }

  return { payload };
}

/**
 * Binds the dedup claim to its key/repository. Without either, the inactive
 * claim stands in so processing proceeds exactly as before dedup existed.
 */
function createDeliveryClaim(
  claimKey: string | undefined,
  deliveryRepository: DeliveryRepository | undefined,
): DeliveryClaim {
  if (!claimKey || !deliveryRepository) {
    return INACTIVE_CLAIM;
  }
  return {
    key: claimKey,
    acquire: async (logger: FastifyBaseLogger) => {
      try {
        return await deliveryRepository.claim(claimKey);
      } catch (err) {
        // A dedup outage must not block reviews — proceed without a claim.
        logger.warn(
          `[PrEventsPush] Delivery dedup unavailable, proceeding: ${String(err)}`,
        );
        return true;
      }
    },
    release: async () => {
      await deliveryRepository.release(claimKey);
    },
    settle: async () => {
      await deliveryRepository.markDone(claimKey).catch(() => undefined);
    },
  };
}

/** Acks (200) a deterministic failure and marks the delivery done. */
async function ackNonRetryableFailure(
  error: NonRetryableTaskError,
  claim: DeliveryClaim,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  // Deterministic failure: redelivery repeats the same paid work and
  // fails identically. Ack, and rely on the recorded PR status (set by
  // the orchestrator) for observability.
  request.log.warn(
    `[PrEventsPush] Non-retryable failure, acking: ${error.message}`,
  );
  await claim.settle();
  return reply.status(200).send({
    success: false,
    reason: 'Non-retryable failure',
    error: error.message,
  });
}

async function processPrEvent(
  payload: PREventPayload,
  claim: DeliveryClaim,
  options: PrEventsPushRoutesOptions,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  try {
    request.log.info(
      `[PrEventsPush] Processing PR event for ${payload.prMeta.owner}/${payload.prMeta.repo} #${payload.prMeta.prNumber}`,
    );
    const res = await options.orchestrator.ingestPREvent(payload, request.log);
    await claim.settle();
    return reply.status(200).send({
      success: true,
      data: res,
    });
  } catch (error) {
    if (error instanceof NonRetryableTaskError) {
      return ackNonRetryableFailure(error, claim, request, reply);
    }
    request.log.error(
      `[PrEventsPush] Error processing PR event: ${String(error)}`,
    );
    // Release the claim so the Pub/Sub redelivery can retry.
    await claim.release();
    return reply.status(500).send({
      success: false,
      error: String(error),
    });
  }
}

export const prEventsPushRoutes: FastifyPluginAsync<
  PrEventsPushRoutesOptions
> = async (fastify: FastifyInstance, options: PrEventsPushRoutesOptions) => {
  fastify.post('/pr-events', async (request, reply) => {
    const envelope = parsePushEnvelope(request.body, request.log);
    if (envelope.failure) {
      return reply.status(200).send(envelope.failure);
    }

    // Dedup: Pub/Sub redelivers the same messageId when an ack deadline is
    // exceeded, and GitHub often fires `opened` + `review_requested` for the
    // same commit SHA simultaneously.
    const messageId = extractPushMessageId(request.body);
    const claimKey = resolveClaimKey(envelope.payload, messageId);
    const claim = createDeliveryClaim(claimKey, options.deliveryRepository);
    if (!(await claim.acquire(request.log))) {
      request.log.info(
        `[PrEventsPush] Skipping duplicate delivery ${claim.key}`,
      );
      return reply.status(200).send({
        success: false,
        reason: 'Duplicate delivery',
      });
    }

    return processPrEvent(envelope.payload, claim, options, request, reply);
  });
};
