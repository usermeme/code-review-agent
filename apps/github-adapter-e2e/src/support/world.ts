import { IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { Octokit } from '@octokit/rest';
import { EnvService } from 'env';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildServer as buildAdapterServer } from '../../../github-adapter/src/app.js';
import {
  adapterEnvSchema,
  AdapterEnvService,
} from '../../../github-adapter/src/env.js';
import { GithubService } from '../../../github-adapter/src/modules/github/github.service.js';
import { MockOctokit } from './doubles/mock-octokit.js';

export class GithubAdapterWorld extends World {
  public app!: FastifyInstance;
  public octokit: MockOctokit;
  public githubService!: GithubService;
  public envService!: AdapterEnvService;
  public lastResponse?: LightMyRequestResponse;

  constructor(options: IWorldOptions) {
    super(options);
    this.octokit = new MockOctokit();
  }

  async initApp(): Promise<void> {
    this.envService = new EnvService(adapterEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      GITHUB_TOKEN: 'test-github-token',
    });

    this.githubService = new GithubService({
      octokit: this.octokit as unknown as Octokit,
      envService: this.envService,
    });

    this.app = await buildAdapterServer({
      envService: this.envService,
      githubService: this.githubService,
      fastifyOptions: { logger: false },
    });
  }

  async cleanup(): Promise<void> {
    if (this.app) {
      await this.app.close();
    }
    this.octokit.clear();
  }
}

setWorldConstructor(GithubAdapterWorld);
