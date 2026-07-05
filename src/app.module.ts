import fastify, { type FastifyInstance } from 'fastify';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { webhookRoutes } from './modules/webhook/webhook.routes.js';
import type { Services } from "./wiring.js";

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function createApp(services: Services): FastifyInstance {
  const app = fastify({ logger: false });

  // Custom parser to keep rawBody string for GitHub signature verification
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      req.rawBody = body as string;
      const json: unknown = JSON.parse(body as string);
      done(null, json);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  app.get('/healthz', () => {
    return { ok: true };
  });

  void app.register(webhookRoutes(services), { prefix: '/webhook' });
  void app.register(adminRoutes(services), { prefix: '/admin' });

  return app;
}
