import type { FastifyPluginCallback } from 'fastify';
import { logger } from '../../core/logger/logger.service.js';
import type { Services } from '../../wiring.js';
import { WebhookRouter } from './webhook.service.js';

export function webhookRoutes(services: Services): FastifyPluginCallback {
  return (app, _opts, done) => {
    const router = new WebhookRouter(services);

    app.post('/', async (req, reply) => {
      const webhookReq = {
        headers: req.headers as Record<string, string>,
        rawBody: req.rawBody ?? '',
        body: req.body,
      };

      try {
        const handled = await router.handle(webhookReq);
        if (!handled) {
          return reply.code(400).send({ error: 'unhandled webhook' });
        }
        void reply.code(202).send({ ok: true });
      } catch (error: unknown) {
        if (error instanceof Error && error.message === 'invalid signature') {
          return reply.code(401).send({ error: 'invalid signature' });
        }
        logger.error({ err: error }, 'webhook routing failed');
        return reply.code(500).send({ error: 'internal error' });
      }
    });
    done();
  };
}
