import { FastifyPluginAsync } from 'fastify';
import { GithubService } from '../github/github.service.js';

export interface WebhooksRoutesOptions {
  githubService: GithubService;
}

export const webhooksRoutes: FastifyPluginAsync<WebhooksRoutesOptions> = async (
  fastify,
  options,
) => {
  const { githubService } = options;

  fastify.post('/', { config: { rawBody: true } }, async (request, reply) => {
    if (!request.rawBody) {
      return reply.code(400).send({ error: 'Missing raw body' });
    }

    try {
      const rawBody =
        typeof request.rawBody === 'string'
          ? request.rawBody
          : (request.rawBody?.toString('utf8') ?? '');
      const isValid = await githubService.verifySignature(
        request.headers,
        rawBody,
      );
      if (!isValid) {
        throw new Error('Verification failed');
      }
    } catch (error) {
      fastify.log.error(`Webhook Signature Verification Failed: ${error}`);
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const payload = request.body;

    const result = await githubService.processWebhook(
      request.headers,
      payload,
      fastify.log,
    );

    return result;
  });
};
