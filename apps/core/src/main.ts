import { envService } from './env.js';
import { buildCoreServer } from './app.js';

const host = envService.get('HOST');
const port = envService.get('PORT');

const server = await buildCoreServer({
  envService,
  fastifyOptions: { logger: true },
});

try {
  await server.listen({ port, host });
  server.log.info(`[ Core ready ] http://${host}:${port}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, () => {
    void (async () => {
      server.log.info(`Received ${signal}, shutting down gracefully...`);
      try {
        await server.close();
        server.log.info('Server shutdown complete.');
        process.exit(0);
      } catch (err) {
        server.log.error(err, 'Error during shutdown');
        process.exit(1);
      }
    })();
  });
}
