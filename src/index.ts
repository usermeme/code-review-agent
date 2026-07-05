import { loadConfig } from './config/load.js';
import { createApp } from './server/app.js';
import { logger } from './util/logger.js';
import { buildServices } from './wiring.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const services = await buildServices(cfg);
  const app = createApp(services);

  try {
    await app.listen({ port: cfg.server.port, host: '0.0.0.0' });
    logger.info({ port: cfg.server.port }, 'code-review-agent listening');
  } catch (error) {
    logger.error({ err: error }, 'failed to start fastify server');
    process.exit(1);
  }

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down');
    await app.close();
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
