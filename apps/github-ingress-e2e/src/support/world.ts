import crypto from 'node:crypto';

import { EnvService } from '@code-review-agent/env';
import { PREventPayload } from '@code-review-agent/shared-types';
import { setWorldConstructor, World } from '@cucumber/cucumber';
import { PubSub } from '@google-cloud/pubsub';
import { Webhooks } from '@octokit/webhooks';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildServer as buildIngressServer } from '../../../github-ingress/src/app.js';
import { ingressEnvSchema } from '../../../github-ingress/src/env.js';
import { GithubIngressService } from '../../../github-ingress/src/modules/webhooks/ingress.service.js';

export class GithubIngressWorld extends World {
  public app!: FastifyInstance;
  public ingestedEvents: PREventPayload[] = [];
  public webhookSecret = 'test-webhook-secret';
  public lastResponse?: LightMyRequestResponse;

  async initApp(): Promise<void> {
    const envService = new EnvService(ingressEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      GITHUB_WEBHOOK_SECRET: this.webhookSecret,
      PR_EVENTS_TOPIC: 'test-pr-events-topic',
    });

    this.ingestedEvents = [];
    const pubsub = {
      topic: () => ({
        publishMessage: async ({ json }: { json: PREventPayload }) => {
          this.ingestedEvents.push(json);
        },
      }),
    } as unknown as PubSub;

    // 1. Initialize GithubIngressService
    const webhooks = new Webhooks({ secret: this.webhookSecret });
    const ingressService = new GithubIngressService({
      pubsub,
      envService,
      webhooks,
    });

    // 2. Build Fastify Ingress application
    this.app = await buildIngressServer({
      ingressService,
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
