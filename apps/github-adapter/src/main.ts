import { buildServer } from './app.js';
import { envService } from './env.js';
import { GithubService } from './modules/github/github.service.js';
import { GithubAuthService } from './modules/github/github-auth.service.js';

async function bootstrap() {
  const host = envService.get('HOST');
  const port = envService.get('PORT');

  const appId = envService.get('GITHUB_APP_ID');
  const privateKey = envService.get('GITHUB_APP_PRIVATE_KEY');
  const authService = new GithubAuthService({ appId, privateKey });
  const githubService = new GithubService({ authService });

  const server = await buildServer({
    githubService,
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
