import { parseArgs } from 'node:util';
import { loadConfig } from '../core/config/config.service.js';
import { getRepoInstallationId } from '../integrations/github/app-auth.service.js';
import { backfillRepo } from '../modules/admin/admin.service.js';
import { logger } from '../core/logger/logger.service.js';
import { buildServices } from '../wiring.js';

/** Ingest all historical PR discussions: npm run backfill -- --repo owner/name */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      installation: { type: 'string' },
    } as const,
  });
  const [owner, repo] = (values.repo ?? '').split('/');
  if (!owner || !repo) {
    console.error(
      'Usage: npm run backfill -- --repo <owner/name> [--installation <id>]',
    );
    process.exit(1);
  }

  const services = await buildServices(loadConfig());
  try {
    let installationId: number;
    if (values.installation) {
      installationId = Number(values.installation);
    } else {
      installationId = await getRepoInstallationId(services.app, owner, repo);
    }
    const { stored } = await backfillRepo(services, {
      providerId: 'github',
      installationId: String(installationId),
      repo: { provider: 'github', owner, name: repo },
    });
    logger.info({ repo: values.repo, stored }, 'backfill complete');
  } finally {
    await services.close();
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'backfill failed');
  process.exit(1);
});
