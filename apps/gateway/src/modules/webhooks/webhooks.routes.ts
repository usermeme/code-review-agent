import { FastifyPluginAsync } from 'fastify';
import { WebhooksService } from './webhooks.service.js';

export const webhooksRoutes: FastifyPluginAsync<{ webhooksService: WebhooksService }> = async (fastify, options) => {
  const { webhooksService } = options;

  fastify.post('/webhook', { config: { rawBody: true } }, async (request, reply) => {
    if (!request.rawBody) {
      return reply.code(400).send({ error: 'Missing raw body' });
    }

    const adapter = webhooksService.getAdapterForRequest(request.headers);
    if (!adapter) {
      return reply.code(400).send({ error: 'Unsupported Git Provider or Missing Headers' });
    }

    try {
      // Verify Cryptographic Signature
      const isValid = await webhooksService.verifySignature(adapter, request.headers, request.rawBody);
      if (!isValid) {
        throw new Error('Verification failed');
      }
    } catch (error) {
      fastify.log.error(`Webhook Signature Verification Failed: ${error}`);
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    // Parse the JSON body now that it is verified
    const payload = request.body as any;

    const result = await webhooksService.processEvent(adapter, request.headers, payload, fastify.log);
    
    return result;
  });
};
