import { PubSub } from '@google-cloud/pubsub';
import { Webhooks } from '@octokit/webhooks';

import { buildServer } from './app.js';
import { envService } from './env.js';
import { GithubIngressService } from './modules/webhooks/ingress.service.js';

async function bootstrap() {
  const host = envService.get('HOST');
  const port = envService.get('PORT');

  const pubsub = new PubSub({
    projectId: envService.get('GOOGLE_CLOUD_PROJECT'),
  });

  const webhooks = new Webhooks({
    secret: envService.get('GITHUB_WEBHOOK_SECRET'),
  });

  const ingressService = new GithubIngressService({
    pubsub,
    envService,
    webhooks,
  });

  const server = await buildServer({
    ingressService,
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
