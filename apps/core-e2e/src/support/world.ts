import { setWorldConstructor, World, IWorldOptions } from '@cucumber/cucumber';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildCoreServer } from '../../../core/src/app.js';
import { InMemoryDatabaseService } from './doubles/in-memory-db.service.js';
import { MockPubSub } from './doubles/mock-pubsub.js';
import { PrRepository } from '../../../core/src/modules/database/repositories/pr.repository.js';
import { ContextRepository } from '../../../core/src/modules/database/repositories/context.repository.js';
import { EventOrchestratorService } from '../../../core/src/services/event-orchestrator.service.js';
import { createClient, createRouterTransport, Client } from '@connectrpc/connect';
import {
  CoreService,
  GatewayService,
  PostReviewRequest,
  PostReviewResponse,
} from 'contracts';
import { PubSub } from '@google-cloud/pubsub';

export class CoreWorld extends World {
  public app!: FastifyInstance;
  public db: InMemoryDatabaseService;
  public pubsub: MockPubSub;
  public prRepository: PrRepository;
  public contextRepository: ContextRepository;
  public orchestrator!: EventOrchestratorService;
  public postedReviews: PostReviewRequest[] = [];
  public coreRpcClient!: Client<typeof CoreService>;
  public pubsubSecretToken = 'secure-pubsub-token';
  public lastResponse?: LightMyRequestResponse;

  constructor(options: IWorldOptions) {
    super(options);
    this.db = new InMemoryDatabaseService();
    this.pubsub = new MockPubSub();
    this.prRepository = new PrRepository(this.db);
    this.contextRepository = new ContextRepository(this.db);
  }

  async initApp(): Promise<void> {
    process.env['PUBSUB_SECRET_TOKEN'] = this.pubsubSecretToken;
    process.env['BUILD_CONTEXT_TOPIC'] = 'build-context-topic';
    process.env['REVIEW_CODE_TOPIC'] = 'review-code-topic';

    // 1. Mock in-process GatewayService transport
    const gatewayTransport = createRouterTransport((router) => {
      router.service(GatewayService, {
        postReview: async (req: PostReviewRequest): Promise<PostReviewResponse> => {
          this.postedReviews.push(req);
          return {
            $typeName: 'gateway.v1.PostReviewResponse',
            success: true,
            message: 'Review accepted by mock gateway',
            reviewId: `mock-review-${this.postedReviews.length}`,
          };
        },
      });
    });
    const gatewayClient = createClient(GatewayService, gatewayTransport);

    // 2. Initialize Orchestrator
    this.orchestrator = new EventOrchestratorService({
      pubsub: this.pubsub as unknown as PubSub,
      prRepository: this.prRepository,
      contextRepository: this.contextRepository,
      gatewayClient,
    });

    // 3. Build Core Fastify application
    this.app = await buildCoreServer({
      databaseService: this.db,
      prRepository: this.prRepository,
      contextRepository: this.contextRepository,
      gatewayClient,
      orchestrator: this.orchestrator,
      fastifyOptions: { logger: false },
    });

    // 4. In-process ConnectRPC client pointing to coreApp's orchestrator
    const coreTransport = createRouterTransport((router) => {
      router.service(CoreService, {
        ingestPREvent: async (req) => {
          return await this.orchestrator.ingestPREvent(req);
        },
      });
    });
    this.coreRpcClient = createClient(CoreService, coreTransport);
  }

  async cleanup(): Promise<void> {
    if (this.app) {
      await this.app.close();
    }
    this.db.clear();
    this.pubsub.clear();
    this.postedReviews = [];
  }
}

setWorldConstructor(CoreWorld);
