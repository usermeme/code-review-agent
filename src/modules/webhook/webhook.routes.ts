import type { FastifyPluginCallback } from 'fastify';
import { getFirstHeader } from '../../common/utils/headers.util.js';
import { logger } from '../../core/logger/logger.service.js';
import type { Services } from '../../wiring.js';
import { WebhookRouter, type WebhookPayload } from './webhook.service.js';

export function webhookRoutes(services: Services): FastifyPluginCallback {
  return (app, _opts, done) => {
    const router = new WebhookRouter(services);

    app.post<{ Body: WebhookPayload }>('/', async (req, reply) => {
      const signatureHeader = req.headers['x-hub-signature-256'];
      const eventNameHeader = req.headers['x-github-event'];

      const signature = getFirstHeader(signatureHeader) ?? '';
      const eventName = getFirstHeader(eventNameHeader) ?? '';
      const rawBody = req.rawBody ?? '';

      if (!signature || !(await router.verify(rawBody, signature))) {
        return reply.code(401).send({ error: 'invalid signature' });
      }

      void reply.code(202).send({ ok: true });

      try {
        router.route(eventName, req.body);
      } catch (error) {
        logger.error({ event: eventName, err: error }, 'webhook routing failed');
      }
    });
    done();
  };
}
