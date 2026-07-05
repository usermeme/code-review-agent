import { loadConfig } from '../core/config/config.service.js';
import { createPool, runMigrations } from '../modules/discussion/db.service.js';
import { logger } from '../core/logger/logger.service.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = createPool(cfg.discussions.databaseUrl);
  try {
    await runMigrations(pool);
    logger.info('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'migration failed');
  process.exit(1);
});
