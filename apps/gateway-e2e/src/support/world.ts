import { setWorldConstructor, World, IWorldOptions } from '@cucumber/cucumber';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';
import crypto from 'node:crypto';
import { buildServer } from '../../../gateway/src/app.js';
import { InMemoryDatabaseService } from './doubles/in-memory-db.service.js';
import { MockPubSub } from './doubles/mock-pubsub.js';
import { MockOctokit } from './doubles/mock-octokit.js';
import { PrRepository } from '../../../gateway/src/modules/database/repositories/pr.repository.js';
import { ContextRepository } from '../../../gateway/src/modules/database/repositories/context.repository.js';
import { PubSub } from '@google-cloud/pubsub';
import { Octokit } from '@octokit/rest';
import { GitService } from '../../../gateway/src/modules/git/git.service.js';
import { GithubAdapter } from '../../../gateway/src/modules/git/adapters/github.adapter.js';

export class GatewayWorld extends World {
  public app!: FastifyInstance;
  public db: InMemoryDatabaseService;
  public pubsub: MockPubSub;
  public octokit: MockOctokit;
  public prRepository: PrRepository;
  public contextRepository: ContextRepository;
  public gitService!: GitService;
  public githubAdapter!: GithubAdapter;
  public webhookSecret = 'test-webhook-secret';
  public pubsubSecretToken = 'secure-pubsub-token';
  public lastResponse?: LightMyRequestResponse;

  constructor(options: IWorldOptions) {
    super(options);
    this.db = new InMemoryDatabaseService();
    this.pubsub = new MockPubSub();
    this.octokit = new MockOctokit();
    this.prRepository = new PrRepository(this.db);
    this.contextRepository = new ContextRepository(this.db);
  }

  async initApp(): Promise<void> {
    process.env.GIT_ADAPTER_WEBHOOK_SECRET = this.webhookSecret;
    process.env.PUBSUB_SECRET_TOKEN = this.pubsubSecretToken;

    this.gitService = new GitService();
    this.githubAdapter = new GithubAdapter(
      this.prRepository,
      this.contextRepository,
      {
        pubsub: this.pubsub as unknown as PubSub,
        octokit: this.octokit as unknown as Octokit,
      },
    );
    this.gitService.registerAdapter('github', this.githubAdapter);

    this.app = await buildServer({
      databaseService: this.db,
      prRepository: this.prRepository,
      contextRepository: this.contextRepository,
      gitService: this.gitService,
      fastifyOptions: { logger: false },
    });
  }

  createHmacSignature(payload: string, secret = this.webhookSecret): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  async cleanup(): Promise<void> {
    if (this.app) {
      await this.app.close();
    }
    this.db.clear();
    this.pubsub.clear();
    this.octokit.clear();
  }
}

setWorldConstructor(GatewayWorld);
