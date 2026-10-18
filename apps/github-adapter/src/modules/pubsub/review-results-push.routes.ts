import { parsePubSubPushPayload } from '@code-review-agent/pubsub';
import {
  NonRetryableTaskError,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { formatError, GithubService } from '../github/github.service.js';

export interface ReviewResultsPushRoutesOptions {
  githubService: GithubService;
}

function hasValidPrReference(
  payload: ReviewResultPayload | undefined,
): boolean {
  return Boolean(
    payload?.owner && payload.repo && typeof payload.prNumber === 'number',
  );
}

function buildPostReviewOptions(payload: ReviewResultPayload) {
  return {
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.prNumber,
    summary: payload.summary || '',
    ticketCoverage: payload.ticketCoverage,
    comments: payload.comments || [],
  };
}

function handlePostReviewError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof NonRetryableTaskError) {
    request.log.warn(
      `[ReviewResultsPush] Non-retryable failure, acking: ${error.message}`,
    );
    return reply.status(200).send({
      success: false,
      reason: 'Non-retryable failure',
      error: error.message,
    });
  }
  const message = formatError(error);
  request.log.error(
    `[ReviewResultsPush] Error posting review results: ${message}`,
  );
  return reply.status(500).send({
    success: false,
    error: message,
  });
}

export const reviewResultsPushRoutes: FastifyPluginAsync<
  ReviewResultsPushRoutesOptions
> = async (
  fastify: FastifyInstance,
  options: ReviewResultsPushRoutesOptions,
) => {
  fastify.post('/review-results', async (request, reply) => {
    let payload: ReviewResultPayload;
    try {
      payload = parsePubSubPushPayload<ReviewResultPayload>(request.body);
    } catch (err) {
      request.log.warn(
        `[ReviewResultsPush] Malformed Pub/Sub envelope: ${String(err)}`,
      );
      return reply.status(200).send({
        success: false,
        reason: 'Malformed Pub/Sub envelope',
      });
    }

    if (!hasValidPrReference(payload)) {
      request.log.warn(
        '[ReviewResultsPush] Invalid payload structure in push message',
      );
      return reply.status(200).send({
        success: false,
        reason: 'Invalid payload structure',
      });
    }

    try {
      request.log.info(
        `[ReviewResultsPush] Posting review results for ${payload.owner}/${payload.repo} #${payload.prNumber}`,
      );
      const res = await options.githubService.postReview(
        buildPostReviewOptions(payload),
      );
      return reply.status(200).send({
        success: res.success,
        data: res,
      });
    } catch (error) {
      return handlePostReviewError(error, request, reply);
    }
  });
};
