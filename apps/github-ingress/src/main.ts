import { PubSub } from '@google-cloud/pubsub';

import { buildServer } from './app.js';
import { envService } from './env.js';

async function bootstrap() {
  const host = envService.get('HOST');
  const port = envService.get('PORT');

  const pubsub = new PubSub({
    projectId: envService.get('GOOGLE_CLOUD_PROJECT'),
  });

  const server = await buildServer({
    envService,
    pubsub,
  });

  try {
    await server.listen({ host, port });
    server.log.info(
      `[github-ingress] Server listening at http://${host}:${port}`,
    );
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

void bootstrap();
