import { FastifyPluginAsync } from 'fastify';
import { WebhooksService } from './webhooks.service.js';
import { GitService } from '../git/git.service.js';

export const webhooksRoutes: FastifyPluginAsync<{
  webhooksService: WebhooksService;
  gitService: GitService;
}> = async (fastify, options) => {
  const { webhooksService, gitService } = options;

  fastify.post(
    '/',
    { config: { rawBody: true } },
    async (request, reply) => {
      if (!request.rawBody) {
        return reply.code(400).send({ error: 'Missing raw body' });
      }

      const match = gitService.getAdapterForRequest(request.headers);
      if (!match) {
        return reply
          .code(400)
          .send({ error: 'Unsupported Git Provider or Missing Headers' });
      }

      const adapter = match.adapter;

      try {
        const isValid = await webhooksService.verifySignature(
          adapter,
          request.headers,
          request.rawBody,
        );
        if (!isValid) {
          throw new Error('Verification failed');
        }
      } catch (error) {
        fastify.log.error(`Webhook Signature Verification Failed: ${error}`);
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      const payload = request.body;

      const result = await webhooksService.processEvent(
        adapter,
        request.headers,
        payload,
        fastify.log,
      );

      return result;
    },
  );
};
