import { parseArgs } from 'node:util';
import { runReview } from '../modules/review/review.service.js';
import { loadConfig } from '../core/config/config.service.js';
import { getRepoInstallationId } from '../integrations/github/app-auth.service.js';
import { logger } from '../core/logger/logger.service.js';
import { buildServices } from '../wiring.js';

/** Direct review of one PR, no webhook needed: npm run review -- --repo owner/name --pr 3 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      installation: { type: 'string' },
    },
  });
  const [owner, repo] = (values.repo ?? '').split('/');
  const prNumber = Number(values.pr);
  if (!owner || !repo || !prNumber) {
    console.error('Usage: npm run review -- --repo <owner/name> --pr <number> [--installation <id>]');
    process.exit(1);
  }

  const services = await buildServices(loadConfig());
  try {
    const installationId = values.installation
      ? Number(values.installation)
      : await getRepoInstallationId(services.app, owner, repo);
    await runReview(services.reviewDeps, {
      installationId,
      owner,
      repo,
      prNumber,
    });
    logger.info({ repo: values.repo, pr: prNumber }, 'review complete');
  } finally {
    await services.close();
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'review failed');
  process.exit(1);
});
