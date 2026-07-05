import { loadConfig } from './config/load.js';
import { createApp } from './server/app.js';
import { logger } from './util/logger.js';
import { buildServices } from './wiring.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const services = await buildServices(cfg);
  const app = createApp(services);

  const server = app.listen(cfg.server.port, () => {
    logger.info({ port: cfg.server.port }, 'code-review-agent listening');
  });

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down');
    server.close();
    await services.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error) => {
  logger.error({ err: error }, 'fatal startup error');
  process.exit(1);
});
