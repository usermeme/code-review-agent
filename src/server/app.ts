import { timingSafeEqual } from 'node:crypto';
import fastify, { type FastifyInstance } from 'fastify';
import { getRepoInstallationId } from '../github/app-auth.js';
import { logger } from '../util/logger.js';
import type { Services } from '../wiring.js';
import { backfillRepo } from './backfill.js';
import { WebhookRouter, type WebhookPayload } from './webhook-router.js';

/** Constant-time bearer-token check. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function createApp(services: Services): FastifyInstance {
  const router = new WebhookRouter(services);
  const app = fastify({ logger: false });

  // Custom parser to keep rawBody string for GitHub signature verification
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      (req as any).rawBody = body;
      const json = JSON.parse(body as string);
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.get('/healthz', async () => {
    return { ok: true };
  });

  app.post('/webhook', async (req, reply) => {
    const signatureHeader = req.headers['x-hub-signature-256'];
    const eventNameHeader = req.headers['x-github-event'];

    const signature = (Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader) ?? '';
    const eventName = (Array.isArray(eventNameHeader) ? eventNameHeader[0] : eventNameHeader) ?? '';
    const rawBody = (req as any).rawBody ?? '';

    if (!signature || !(await router.verify(rawBody, signature))) {
      reply.status(401);
      return { error: 'invalid signature' };
    }

    reply.status(202);
    // Send early reply to GitHub and close connection, then route in the background
    void reply.send({ ok: true });

    try {
      router.route(eventName, req.body as WebhookPayload);
    } catch (error) {
      logger.error({ event: eventName, err: error }, 'webhook routing failed');
    }
  });

  app.post('/admin/backfill/:owner/:repo', async (req, reply) => {
    const adminToken = process.env['ADMIN_TOKEN'];
    if (!adminToken) {
      logger.warn('rejecting /admin/backfill: ADMIN_TOKEN is not configured');
      reply.status(503);
      return { error: 'admin endpoint disabled: ADMIN_TOKEN not configured' };
    }

    const authHeader = req.headers['authorization'];
    const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!bearerMatches(auth, adminToken)) {
      reply.status(401);
      return { error: 'unauthorized' };
    }

    const { owner, repo } = req.params as { owner: string; repo: string };
    const body = req.body as { installationId?: number } | undefined;

    try {
      const installationId = Number(body?.installationId) || (await getRepoInstallationId(services.app, owner, repo));
      reply.status(202);
      void reply.send({ started: true });

      void backfillRepo(services, { installationId, owner, repo }).catch((error: unknown) =>
        logger.error({ owner, repo, err: error }, 'backfill failed'),
      );
    } catch (error) {
      logger.error({ owner, repo, err: error }, 'backfill start failed');
      if (!reply.sent) {
        reply.status(500);
        return { error: 'backfill failed to start' };
      }
    }
  });

  return app;
}
