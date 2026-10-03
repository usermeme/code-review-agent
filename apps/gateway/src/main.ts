import { buildServer } from './app.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

const server = await buildServer({
  fastifyOptions: { logger: true },
});

try {
  await server.listen({ port, host });
  server.log.info(`[ ready ] http://${host}:${port}`);
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
