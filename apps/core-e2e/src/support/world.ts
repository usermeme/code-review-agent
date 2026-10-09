import { setWorldConstructor, World, IWorldOptions } from '@cucumber/cucumber';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildCoreServer } from '../../../core/src/app.js';
import { InMemoryDatabaseService } from './doubles/in-memory-db.service.js';
import { MockPubSub } from './doubles/mock-pubsub.js';
import { PrRepository } from '../../../core/src/modules/database/repositories/pr.repository.js';
import { ContextRepository } from '../../../core/src/modules/database/repositories/context.repository.js';
import { EventOrchestratorService } from '../../../core/src/services/event-orchestrator.service.js';
import {
  createClient,
  createRouterTransport,
  Client,
} from '@connectrpc/connect';
import { CoreService } from 'contracts';
import { PubSub } from '@google-cloud/pubsub';
import { EnvService } from 'env';
import { coreEnvSchema, CoreEnvService } from '../../../core/src/env.js';
import { ReviewResultPayload } from 'shared-types';

export class CoreWorld extends World {
  public app!: FastifyInstance;
  public db: InMemoryDatabaseService;
  public pubsub: MockPubSub;
  public prRepository: PrRepository;
  public contextRepository: ContextRepository;
  public orchestrator!: EventOrchestratorService;
  public envService!: CoreEnvService;
  public coreRpcClient!: Client<typeof CoreService>;
  public internalAuthToken = 'secure-pubsub-token';
  public lastResponse?: LightMyRequestResponse;

  constructor(options: IWorldOptions) {
    super(options);
    this.db = new InMemoryDatabaseService();
    this.pubsub = new MockPubSub();
    this.prRepository = new PrRepository(this.db);
    this.contextRepository = new ContextRepository(this.db);
  }

  get postedReviews(): ReviewResultPayload[] {
    const topic = this.envService.get('REVIEW_RESULTS_TOPIC');
    return this.pubsub
      .getMessagesByTopic(topic)
      .map((m) => m.json as ReviewResultPayload);
  }

  async initApp(): Promise<void> {
    this.envService = new EnvService(coreEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      PR_EVENTS_SUBSCRIPTION: 'test-pr-events-sub',
      REVIEW_RESULTS_TOPIC: 'test-review-results-topic',
      BUILD_CONTEXT_TOPIC: 'build-context-topic',
      REVIEW_CODE_TOPIC: 'review-code-topic',
      INTERNAL_AUTH_TOKEN: this.internalAuthToken,
    });

    // 1. Initialize Orchestrator
    this.orchestrator = new EventOrchestratorService({
      pubsub: this.pubsub as unknown as PubSub,
      prRepository: this.prRepository,
      contextRepository: this.contextRepository,
      envService: this.envService,
    });

    // 2. Build Core Fastify application
    this.app = await buildCoreServer({
      databaseService: this.db,
      prRepository: this.prRepository,
      contextRepository: this.contextRepository,
      orchestrator: this.orchestrator,
      pubsub: this.pubsub as unknown as PubSub,
      startConsumer: false,
      envService: this.envService,
      fastifyOptions: { logger: false },
    });

    // 3. In-process ConnectRPC client pointing to coreApp's orchestrator (for legacy step compatibility)
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
  }
}

setWorldConstructor(CoreWorld);
