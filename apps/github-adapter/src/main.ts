import { PubSub } from '@google-cloud/pubsub';
import { envService } from './env.js';
import { buildServer } from './app.js';

async function bootstrap() {
  const host = envService.get('HOST');
  const port = envService.get('PORT');

  const subscriptionName = envService.get('REVIEW_RESULTS_SUBSCRIPTION');
  const pubsub = subscriptionName
    ? new PubSub({
        projectId: envService.get('GOOGLE_CLOUD_PROJECT'),
      })
    : undefined;

  const server = await buildServer({
    envService,
    pubsub,
  });

  try {
    await server.listen({ host, port });
    server.log.info(
      `[github-adapter] Server listening at http://${host}:${port}`,
    );
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

void bootstrap();
