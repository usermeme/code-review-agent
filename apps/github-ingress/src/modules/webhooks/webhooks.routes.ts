import { FastifyPluginAsync } from 'fastify';

import { GithubIngressService } from './ingress.service.js';

export interface WebhooksRoutesOptions {
  ingressService: GithubIngressService;
}

function extractRawBody(rawBody: string | Buffer): string {
  return typeof rawBody === 'string'
    ? rawBody
    : (rawBody?.toString('utf8') ?? '');
}

export const webhooksRoutes: FastifyPluginAsync<WebhooksRoutesOptions> = async (
  fastify,
  options,
) => {
  const { ingressService } = options;

  fastify.post('/', { config: { rawBody: true } }, async (request, reply) => {
    if (!request.rawBody) {
      return reply.code(400).send({ error: 'Missing raw body' });
    }

    try {
      const rawBody = extractRawBody(request.rawBody);
      const isValid = await ingressService.verifySignature(
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

    const result = await ingressService.processWebhook(
      request.headers,
      payload,
      fastify.log,
    );

    return result;
  });
};
