import { setWorldConstructor, World, IWorldOptions } from '@cucumber/cucumber';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';
import crypto from 'node:crypto';
import { buildServer as buildGatewayServer } from '../../../github-gateway/src/app.js';
import { MockOctokit } from './doubles/mock-octokit.js';
import { GithubService } from '../../../github-gateway/src/modules/github/github.service.js';
import {
  createClient,
  createRouterTransport,
  Client,
} from '@connectrpc/connect';
import {
  CoreService,
  GatewayService,
  IngestPREventRequest,
  IngestPREventResponse,
} from 'contracts';
import { Octokit } from '@octokit/rest';
import { EnvService } from 'env';
import {
  gatewayEnvSchema,
  GatewayEnvService,
} from '../../../github-gateway/src/env.js';

export class GithubGatewayWorld extends World {
  public app!: FastifyInstance;
  public octokit: MockOctokit;
  public githubService!: GithubService;
  public envService!: GatewayEnvService;
  public ingestedEvents: IngestPREventRequest[] = [];
  public webhookSecret = 'test-webhook-secret';
  public internalToken = 'test-internal-token';
  public lastResponse?: LightMyRequestResponse;
  public gatewayRpcClient!: Client<typeof GatewayService>;

  constructor(options: IWorldOptions) {
    super(options);
    this.octokit = new MockOctokit();
  }

  async initApp(): Promise<void> {
    this.envService = new EnvService(gatewayEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      CORE_URL: 'http://localhost:8080',
      GITHUB_WEBHOOK_SECRET: this.webhookSecret,
      GITHUB_TOKEN: 'test-github-token',
      INTERNAL_AUTH_TOKEN: this.internalToken,
    });

    // 1. Mock in-process ConnectRPC transport for CoreService
    const coreTransport = createRouterTransport((router) => {
      router.service(CoreService, {
        ingestPREvent: async (
          req: IngestPREventRequest,
        ): Promise<IngestPREventResponse> => {
          this.ingestedEvents.push(req);
          return {
            $typeName: 'core.v1.IngestPREventResponse',
            success: true,
            status: 'accepted',
            message: 'Event accepted by mock core',
          };
        },
      });
    });
    const coreClient = createClient(CoreService, coreTransport);

    // 2. Initialize GithubService
    this.githubService = new GithubService({
      octokit: this.octokit as unknown as Octokit,
      coreClient,
      envService: this.envService,
    });

    // 3. Build Fastify Gateway application
    this.app = await buildGatewayServer({
      githubService: this.githubService,
      coreClient,
      envService: this.envService,
      fastifyOptions: { logger: false },
    });

    // 4. In-process ConnectRPC client pointing to gatewayApp
    const gatewayTransport = createRouterTransport((router) => {
      router.service(GatewayService, {
        postReview: async (req) => {
          const result = await this.githubService.postReview({
            owner: req.owner,
            repo: req.repo,
            prNumber: req.prNumber,
            summary: req.summary,
            ticketCoverage: req.ticketCoverage,
            comments: (req.comments || []).map((c) => ({
              path: c.path,
              position: c.position,
              body: c.body,
            })),
          });
          return {
            $typeName: 'gateway.v1.PostReviewResponse',
            success: result.success,
            message: result.message,
            reviewId: result.reviewId || '',
          };
        },
      });
    });

    this.gatewayRpcClient = createClient(GatewayService, gatewayTransport);
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
