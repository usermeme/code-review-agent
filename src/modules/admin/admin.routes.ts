import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginCallback } from 'fastify';
import { getFirstHeader } from '../../common/utils/headers.util.js';
import { logger } from '../../core/logger/logger.service.js';
import type { Services } from '../../wiring.js';
import { backfillRepo } from './admin.service.js';
import type { ProviderId } from '../../integrations/vcs/types/vcs.types.js';

export function bearerMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

interface BackfillParams {
  owner: string;
  repo: string;
}

interface BackfillBody {
  providerId?: string;
  installationId?: string;
}

export function adminRoutes(services: Services): FastifyPluginCallback {
  return (app, _opts, done) => {
    app.post<{ Params: BackfillParams; Body: BackfillBody }>('/backfill/:owner/:repo', async (req, reply) => {
      const adminToken = process.env['ADMIN_TOKEN'];
      if (!adminToken) {
        logger.warn('rejecting /admin/backfill: ADMIN_TOKEN is not configured');
        return reply.code(503).send({ error: 'admin endpoint disabled: ADMIN_TOKEN not configured' });
      }

      const authHeader = req.headers['authorization'];
      const auth = getFirstHeader(authHeader);

      if (!bearerMatches(auth, adminToken)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const { owner, repo } = req.params;
      const body = req.body;
      // Github-specific fallback for now
      const providerId = (body?.providerId || 'github') as ProviderId;

      try {
        const installationId = body?.installationId;

        if (!installationId) {
           return reply.code(400).send({ error: 'installationId is required' });
        }

        void reply.code(202).send({ started: true });

        void backfillRepo(services, { 
          providerId, 
          installationId, 
          repo: { provider: providerId, owner, name: repo } 
        }).catch((error: unknown) =>
          logger.error({ owner, repo, err: error }, 'backfill failed'),
        );
      } catch (error) {
        logger.error({ owner, repo, err: error }, 'backfill start failed');
        if (!reply.sent) {
          return reply.code(500).send({ error: 'backfill failed to start' });
        }
      }
    });
    done();
  };
}
