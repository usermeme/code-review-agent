import { CoreService } from '@code-review-agent/contracts';
import { EnvService } from '@code-review-agent/env';
import { ReviewResultPayload } from '@code-review-agent/shared-types';
import {
  Client,
  createClient,
  createRouterTransport,
} from '@connectrpc/connect';
import { IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildCoreServer } from '../../../core/src/app.js';
import { coreEnvSchema, CoreEnvService } from '../../../core/src/env.js';
import { ContextRepository } from '../../../core/src/modules/database/repositories/context.repository.js';
import { LeaseRepository } from '../../../core/src/modules/database/repositories/lease.repository.js';
import { PrRepository } from '../../../core/src/modules/database/repositories/pr.repository.js';
import { EventOrchestratorService } from '../../../core/src/services/event-orchestrator.service.js';
import { InMemoryDatabaseService } from './doubles/in-memory-db.service.js';
import { MockPubSub } from './doubles/mock-pubsub.js';

export class CoreWorld extends World {
  public app!: FastifyInstance;
  public db: InMemoryDatabaseService;
  public pubsub: MockPubSub;
  public prRepository: PrRepository;
  public contextRepository: ContextRepository;
  public leaseRepository: LeaseRepository;
  public orchestrator!: EventOrchestratorService;
  public envService!: CoreEnvService;
  public coreRpcClient!: Client<typeof CoreService>;
  public lastResponse?: LightMyRequestResponse;

  constructor(options: IWorldOptions) {
    super(options);
    this.db = new InMemoryDatabaseService();
    this.pubsub = new MockPubSub();
    this.prRepository = new PrRepository(this.db);
    this.contextRepository = new ContextRepository(this.db);
    this.leaseRepository = new LeaseRepository(this.db);
  }

  get postedReviews(): ReviewResultPayload[] {
    const topic = this.envService.get('REVIEW_RESULTS_TOPIC');
    return this.pubsub
      .getMessagesByTopic(topic)
      .map((m) => m.json as unknown as ReviewResultPayload);
  }

  async initApp(): Promise<void> {
    this.envService = new EnvService(coreEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      REVIEW_RESULTS_TOPIC: 'test-review-results-topic',
      CONTEXT_BUILD_TOPIC: 'test-context-builds-topic',
      LLM_PROVIDER: 'mock',
      REVIEW_MODEL: 'test-model',
      GIT_ADAPTER_URL: 'http://adapter:8080',
    });

    // 1. Initialize Orchestrator with mock in-process agent executors
    this.orchestrator = new EventOrchestratorService({
      pubsub: this.pubsub as unknown as PubSub,
      prRepository: this.prRepository,
      contextRepository: this.contextRepository,
      leaseRepository: this.leaseRepository,
      envService: this.envService,
      agentService: {
        buildRepoContext: async (input) => ({
          sections: {
            architecture: `Architecture for ${input.repo}`,
            modules: 'core, gateway',
            patterns: 'repositories wrap Firestore',
            errorHandling: 'errors are logged and rethrown',
          },
          agentDocs: [],
        }),
        runReview: async (input) => {
          return {
            provider: input.prMeta.provider || 'github',
            owner: input.prMeta.owner || 'usermeme',
            repo: input.prMeta.repo,
            prNumber: input.prMeta.number,
            summary: 'Automated review completed',
            comments: [
              {
                path: 'src/main.ts',
                line: 1,
                body: 'Automated inline review comment',
              },
            ],
          };
        },
      },
    });

    // 2. Build Core Fastify application
    this.app = await buildCoreServer({
      envService: this.envService,
      pubsub: this.pubsub as unknown as PubSub,
      databaseService: this.db,
      prRepository: this.prRepository,
      contextRepository: this.contextRepository,
      orchestrator: this.orchestrator,
      fastifyOptions: { logger: false },
    });

    // 3. In-process ConnectRPC client pointing to coreApp's orchestrator
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
