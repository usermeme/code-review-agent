import { envService } from './env.js';
import { createCodeReviewerAgent } from './agent.js';
import { buildCodeReviewerServer } from './app.js';

// Export agent instance for ADK CLI & local tooling compatibility
export const codeReviewAgent = createCodeReviewerAgent(envService);
export const rootAgent = codeReviewAgent;
export default codeReviewAgent;

async function start(): Promise<void> {
  const host = envService.get('HOST');
  const port = Number(envService.get('PORT'));

  const server = await buildCodeReviewerServer({
    envService,
    fastifyOptions: { logger: true },
  });

  try {
    await server.listen({ port, host });
    server.log.info(`[ Agent Code Reviewer ready ] http://${host}:${port}`);
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
