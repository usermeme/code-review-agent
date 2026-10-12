import { Octokit } from '@octokit/rest';

import { buildServer } from './app.js';
import { envService } from './env.js';
import { GithubService } from './modules/github/github.service.js';

async function bootstrap() {
  const host = envService.get('HOST');
  const port = envService.get('PORT');

  const token = envService.get('GITHUB_TOKEN');
  const octokit = new Octokit({ auth: token });
  const githubService = new GithubService({ octokit });

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
