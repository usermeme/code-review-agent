import { timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
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

/** Express 4 drops rejected promises from async handlers; route them to next(). */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createApp(services: Services): Express {
  const router = new WebhookRouter(services);
  const app = express();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Raw body capture: the HMAC must run over the exact bytes GitHub sent.
  app.post(
    '/webhook',
    express.raw({ type: '*/*', limit: '25mb' }),
    asyncHandler(async (req, res) => {
      const signature = req.header('x-hub-signature-256') ?? '';
      const eventName = req.header('x-github-event') ?? '';
      const rawBody = (req.body as Buffer).toString('utf8');

      if (!signature || !(await router.verify(rawBody, signature))) {
        res.status(401).json({ error: 'invalid signature' });
        return;
      }

      res.status(202).json({ ok: true });
      try {
        router.route(eventName, JSON.parse(rawBody) as WebhookPayload);
      } catch (error) {
        logger.error({ event: eventName, err: error }, 'webhook routing failed');
      }
    }),
  );

  app.post(
    '/admin/backfill/:owner/:repo',
    express.json(),
    asyncHandler(async (req, res) => {
      // Fail closed: an unset ADMIN_TOKEN must not leave this endpoint open.
      // The service is publicly reachable (it also serves GitHub webhooks),
      // and backfill drives heavy GitHub/embedding work for any installed repo.
      const adminToken = process.env['ADMIN_TOKEN'];
      if (!adminToken) {
        logger.warn('rejecting /admin/backfill: ADMIN_TOKEN is not configured');
        res.status(503).json({ error: 'admin endpoint disabled: ADMIN_TOKEN not configured' });
        return;
      }
      if (!bearerMatches(req.header('authorization'), adminToken)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const { owner, repo } = req.params as { owner: string; repo: string };
      const body = req.body as { installationId?: number } | undefined;
      try {
        const installationId = Number(body?.installationId) || (await getRepoInstallationId(services.app, owner, repo));
        res.status(202).json({ started: true });
        void backfillRepo(services, { installationId, owner, repo }).catch((error: unknown) =>
          logger.error({ owner, repo, err: error }, 'backfill failed'),
        );
      } catch (error) {
        logger.error({ owner, repo, err: error }, 'backfill start failed');
        if (!res.headersSent) res.status(500).json({ error: 'backfill failed to start' });
      }
    }),
  );

  return app;
}
