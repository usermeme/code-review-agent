import { buildServer } from './app.js';
import { envService } from './env.js';

async function bootstrap() {
  const host = envService.get('HOST');
  const port = envService.get('PORT');

  const server = await buildServer({
    envService,
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
