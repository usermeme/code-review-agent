import { envService } from './env.js';
import { createContextBuilderAgent } from './agent.js';
import { buildContextBuilderServer } from './app.js';

// Export agent instance for ADK CLI & local tooling compatibility
export const contextBuilderAgent = createContextBuilderAgent(envService);
export const rootAgent = contextBuilderAgent;
export default contextBuilderAgent;

async function start(): Promise<void> {
  const host = envService.get('HOST');
  const port = Number(envService.get('PORT'));

  const server = await buildContextBuilderServer({
    envService,
    fastifyOptions: { logger: true },
  });

  try {
    await server.listen({ port, host });
    server.log.info(`[ Agent Context Builder ready ] http://${host}:${port}`);
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
}

void start();
