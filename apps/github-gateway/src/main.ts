import { PubSub } from '@google-cloud/pubsub';
import { envService } from './env.js';
import { buildServer } from './app.js';
import { GithubService } from './modules/github/github.service.js';
import { ReviewResultsConsumer } from './modules/pubsub/review-results.consumer.js';

const host = envService.get('HOST');
const port = envService.get('PORT');

const pubsub = new PubSub();
const githubService = new GithubService({ pubsub, envService });

const server = await buildServer({
  envService,
  githubService,
  fastifyOptions: { logger: true },
});

const consumer = new ReviewResultsConsumer({
  pubsub,
  subscriptionName: envService.get('REVIEW_RESULTS_SUBSCRIPTION'),
  githubService,
  logger: server.log,
});
consumer.start();

server.addHook('onClose', async () => {
  await consumer.stop();
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
