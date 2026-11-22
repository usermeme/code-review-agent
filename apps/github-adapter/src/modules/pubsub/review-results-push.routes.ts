import { parsePubSubPushPayload } from '@code-review-agent/pubsub';
import {
  NonRetryableTaskError,
  ReviewResultPayload,
  ThreadJudgmentsPayload,
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

type ResultsMessage = ReviewResultPayload | ThreadJudgmentsPayload;

function isThreadJudgments(
  payload: ResultsMessage,
): payload is ThreadJudgmentsPayload {
  return payload.kind === 'thread-judgments';
}

function hasValidPrReference(payload: ResultsMessage | undefined): boolean {
  return Boolean(
    payload?.owner && payload.repo && typeof payload.prNumber === 'number',
  );
}

async function applyJudgments(
  payload: ThreadJudgmentsPayload,
  options: ReviewResultsPushRoutesOptions,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const applied = await options.githubService.applyThreadJudgments(payload);
  request.log.info(
    `[ReviewResultsPush] Thread judgments for ${describePr(payload)}: ${applied.reopened} re-opened, ${applied.reacted} confirmed, ${applied.failed} failed, ${applied.dismissedApprovals} approvals dismissed`,
  );
  return reply
    .status(200)
    .send({ success: applied.failed === 0, data: applied });
}

async function postReviewResult(
  payload: ReviewResultPayload,
  options: ReviewResultsPushRoutesOptions,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  logPosting(request, payload);
  const res = await options.githubService.postReview(
    buildPostReviewOptions(payload),
  );
  if (res.event === 'APPROVE') {
    request.log.info(
      `[ReviewResultsPush] Approved ${describePr(payload)} at ${payload.reviewedSha}`,
    );
  }
  return reply.status(200).send({
    success: res.success,
    data: res,
  });
}

function buildPostReviewOptions(payload: ReviewResultPayload) {
  return {
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.prNumber,
    summary: payload.summary || '',
    comments: payload.comments || [],
    ...(payload.approve === true
      ? { approve: true, reviewedSha: payload.reviewedSha }
      : {}),
  };
}

function describePr(payload: ResultsMessage): string {
  return `${payload.owner}/${payload.repo} #${payload.prNumber}`;
}

function logPosting(request: FastifyRequest, payload: ReviewResultPayload) {
  if (payload.failure) {
    // A review-failure notice (timeout / non-retryable abandonment) from
    // core: posted like a normal review so the failure is visible on the
    // PR instead of being silently acked.
    request.log.warn(
      `[ReviewResultsPush] Posting review-failure notice for ${describePr(payload)}: ${payload.failure.reason}`,
    );
    return;
  }
  request.log.info(
    `[ReviewResultsPush] Posting review results for ${describePr(payload)}`,
  );
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
    let payload: ResultsMessage;
    try {
      payload = parsePubSubPushPayload<ResultsMessage>(request.body);
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
      if (isThreadJudgments(payload)) {
        return await applyJudgments(payload, options, request, reply);
      }
      return await postReviewResult(payload, options, request, reply);
    } catch (error) {
      return handlePostReviewError(error, request, reply);
    }
  });
};
