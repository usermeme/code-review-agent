import { buildCoreServer } from './app.js';

const host = process.env['HOST'];
if (!host) {
  throw new Error('HOST environment variable is required');
}
const portStr = process.env['PORT'];
if (!portStr) {
  throw new Error('PORT environment variable is required');
}
const port = Number(portStr);

const server = await buildCoreServer({
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
