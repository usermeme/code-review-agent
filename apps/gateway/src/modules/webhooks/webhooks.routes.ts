import { FastifyPluginAsync } from 'fastify';
import { WebhooksService } from './webhooks.service.js';

export const webhooksRoutes: FastifyPluginAsync<{ webhooksService: WebhooksService }> = async (fastify, options) => {
  const { webhooksService } = options;

  fastify.post('/webhook', { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string;
    const event = request.headers['x-github-event'] as string;
    const id = request.headers['x-github-delivery'] as string;

    if (!signature || !event || !id || !request.rawBody) {
      return reply.code(400).send({ error: 'Missing GitHub webhook headers or body' });
    }

    try {
      // Verify Cryptographic Signature
      const isValid = await webhooksService.verifySignature(request.rawBody, signature);
      if (!isValid) {
        throw new Error('Verification failed');
      }
    } catch (error) {
      fastify.log.error(`Webhook Signature Verification Failed: ${error}`);
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    // Parse the JSON body now that it is verified
    const payload = request.body as any;

    const result = await webhooksService.processEvent(event, payload, fastify.log);
    
    return result;
  });
};
