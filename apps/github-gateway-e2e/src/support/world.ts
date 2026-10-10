import { setWorldConstructor, World, IWorldOptions } from '@cucumber/cucumber';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';
import crypto from 'node:crypto';
import { buildServer as buildGatewayServer } from '../../../github-gateway/src/app.js';
import { MockOctokit } from './doubles/mock-octokit.js';
import { GithubService } from '../../../github-gateway/src/modules/github/github.service.js';
import { Octokit } from '@octokit/rest';
import { EnvService } from 'env';
import {
  gatewayEnvSchema,
  GatewayEnvService,
} from '../../../github-gateway/src/env.js';
import { PubSub } from '@google-cloud/pubsub';
import { PREventPayload } from 'shared-types';

export class GithubGatewayWorld extends World {
  public app!: FastifyInstance;
  public octokit: MockOctokit;
  public githubService!: GithubService;
  public envService!: GatewayEnvService;
  public ingestedEvents: PREventPayload[] = [];
  public webhookSecret = 'test-webhook-secret';
  public lastResponse?: LightMyRequestResponse;
  public pubsub!: PubSub;

  constructor(options: IWorldOptions) {
    super(options);
    this.octokit = new MockOctokit();
  }

  async initApp(): Promise<void> {
    this.envService = new EnvService(gatewayEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      GITHUB_WEBHOOK_SECRET: this.webhookSecret,
      GITHUB_TOKEN: 'test-github-token',
      PR_EVENTS_TOPIC: 'test-pr-events-topic',
      REVIEW_RESULTS_SUBSCRIPTION: 'test-review-results-sub',
    });

    this.ingestedEvents = [];
    this.pubsub = {
      topic: () => ({
        publishMessage: async ({ json }: { json: PREventPayload }) => {
          this.ingestedEvents.push(json);
        },
      }),
      subscription: () => ({
        on: () => {},
        close: async () => {},
      }),
    } as unknown as PubSub;

    // 1. Initialize GithubService
    this.githubService = new GithubService({
      octokit: this.octokit as unknown as Octokit,
      pubsub: this.pubsub,
      envService: this.envService,
    });

    // 2. Build Fastify Gateway application
    this.app = await buildGatewayServer({
      githubService: this.githubService,
      envService: this.envService,
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
    this.octokit.clear();
    this.ingestedEvents = [];
  }
}

setWorldConstructor(GithubGatewayWorld);
