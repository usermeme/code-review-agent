import { loadConfig } from '../config/load.js';
import { createPool, runMigrations } from '../discussions/db.js';
import { logger } from '../util/logger.js';

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
