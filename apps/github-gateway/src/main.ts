import { z } from 'zod';
import { Env } from 'env';
import { buildServer } from './app.js';

const env = new Env(
  z.object({
    HOST: z.string().min(1),
    PORT: z.string().transform(Number),
  }),
);

const host = env.get('HOST');
const port = env.get('PORT');

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
