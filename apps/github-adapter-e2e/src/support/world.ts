import { IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildServer as buildAdapterServer } from '../../../github-adapter/src/app.js';
import { GithubService } from '../../../github-adapter/src/modules/github/github.service.js';
import {
  GithubAppClient,
  GithubAuthService,
} from '../../../github-adapter/src/modules/github/github-auth.service.js';
import { MockGithubApp, MockOctokit } from './doubles/mock-octokit.js';

export class GithubAdapterWorld extends World {
  public app!: FastifyInstance;
  public octokit: MockOctokit;
  public githubApp: MockGithubApp;
  public lastResponse?: LightMyRequestResponse;

  constructor(options: IWorldOptions) {
    super(options);
    this.octokit = new MockOctokit();
    this.githubApp = new MockGithubApp(this.octokit);
  }

  async initApp(): Promise<void> {
    const authService = new GithubAuthService({
      app: this.githubApp as unknown as GithubAppClient,
    });

    const githubService = new GithubService({
      authService,
    });

    this.app = await buildAdapterServer({
      githubService,
      fastifyOptions: { logger: false },
    });
  }

  async cleanup(): Promise<void> {
    if (this.app) {
      await this.app.close();
    }
    this.githubApp.clear();
  }
}

setWorldConstructor(GithubAdapterWorld);
