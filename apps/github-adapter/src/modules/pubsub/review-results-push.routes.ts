import { parsePubSubPushPayload } from '@code-review-agent/pubsub';
import { ReviewResultPayload } from '@code-review-agent/shared-types';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { GithubService } from '../github/github.service.js';

export interface ReviewResultsPushRoutesOptions {
  githubService: GithubService;
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

    if (
      !payload?.owner ||
      !payload?.repo ||
      typeof payload?.prNumber !== 'number'
    ) {
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
      const res = await options.githubService.postReview({
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.prNumber,
        summary: payload.summary || '',
        ticketCoverage: payload.ticketCoverage,
        comments: payload.comments || [],
      });
      return reply.status(200).send({
        success: true,
        data: res,
      });
    } catch (error) {
      request.log.error(
        `[ReviewResultsPush] Error posting review results: ${String(error)}`,
      );
      return reply.status(500).send({
        success: false,
        error: String(error),
      });
    }
  });
};
