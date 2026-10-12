import crypto from 'node:crypto';

import { IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { PubSub } from '@google-cloud/pubsub';
import { EnvService } from 'env';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { PREventPayload } from 'shared-types';

import { buildServer as buildIngressServer } from '../../../github-ingress/src/app.js';
import {
  ingressEnvSchema,
  IngressEnvService,
} from '../../../github-ingress/src/env.js';
import { GithubIngressService } from '../../../github-ingress/src/modules/webhooks/ingress.service.js';

export class GithubIngressWorld extends World {
  public app!: FastifyInstance;
  public ingressService!: GithubIngressService;
  public envService!: IngressEnvService;
  public ingestedEvents: PREventPayload[] = [];
  public webhookSecret = 'test-webhook-secret';
  public lastResponse?: LightMyRequestResponse;
  public pubsub!: PubSub;

  constructor(options: IWorldOptions) {
    super(options);
  }

  async initApp(): Promise<void> {
    this.envService = new EnvService(ingressEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      GITHUB_WEBHOOK_SECRET: this.webhookSecret,
      PR_EVENTS_TOPIC: 'test-pr-events-topic',
    });

    this.ingestedEvents = [];
    this.pubsub = {
      topic: () => ({
        publishMessage: async ({ json }: { json: PREventPayload }) => {
          this.ingestedEvents.push(json);
        },
      }),
    } as unknown as PubSub;

    // 1. Initialize GithubIngressService
    this.ingressService = new GithubIngressService({
      pubsub: this.pubsub,
      envService: this.envService,
      webhookSecret: this.webhookSecret,
    });

    // 2. Build Fastify Ingress application
    this.app = await buildIngressServer({
      envService: this.envService,
      pubsub: this.pubsub,
      ingressService: this.ingressService,
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
    this.ingestedEvents = [];
  }
}

setWorldConstructor(GithubIngressWorld);
