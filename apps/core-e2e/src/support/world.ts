import { EnvService } from '@code-review-agent/env';
import { LlmFactory } from '@code-review-agent/llm';
import { ReviewResultPayload } from '@code-review-agent/shared-types';
import { IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildCoreServer } from '../../../core/src/app.js';
import { coreEnvSchema, CoreEnvService } from '../../../core/src/env.js';
import { GitAdapterClient } from '../../../core/src/modules/adapter/git-adapter.client.js';
import { ContextRepository } from '../../../core/src/modules/database/repositories/context.repository.js';
import { DeliveryRepository } from '../../../core/src/modules/database/repositories/delivery.repository.js';
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
  /** Number of reviews the stubbed agent actually ran. */
  public reviewRuns = 0;
  public orchestrator!: EventOrchestratorService;
  public envService!: CoreEnvService;
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
      .map((m) => m.json as unknown as ReviewResultPayload);
  }

  async initApp(): Promise<void> {
    this.envService = new EnvService(coreEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      REVIEW_RESULTS_TOPIC: 'test-review-results-topic',
      LLM_PROVIDER: 'mock',
      REVIEW_MODEL: 'test-model',
      GIT_ADAPTER_URL: 'http://adapter:8080',
    });

    const gitAdapterClient = new GitAdapterClient(
      this.envService.get('GIT_ADAPTER_URL'),
    );
    const llm = new LlmFactory(this.envService.data).createLlm();

    // 1. Initialize Orchestrator with mock in-process agent executors
    this.orchestrator = new EventOrchestratorService({
      pubsub: this.pubsub as unknown as PubSub,
      prRepository: this.prRepository,
      contextRepository: this.contextRepository,
      envService: this.envService,
      agentService: {
        buildContext: async (options) => {
          return {
            architecture: `Architecture for ${options.repo}`,
            modules: 'core, gateway',
          };
        },
        runReview: async (input) => {
          this.reviewRuns += 1;
          return {
            provider: input.prMeta.provider || 'github',
            owner: input.prMeta.owner || 'usermeme',
            repo: input.prMeta.repo,
            prNumber: input.prMeta.number,
            summary: 'Automated review completed',
            comments: [
              {
                path: 'src/main.ts',
                position: 1,
                body: 'Automated inline review comment',
              },
            ],
          };
        },
      },
      gitAdapterClient,
      llm,
    });

    // 2. Build Core Fastify application
    this.app = await buildCoreServer({
      databaseService: this.db,
      contextRepository: this.contextRepository,
      orchestrator: this.orchestrator,
      deliveryRepository: new DeliveryRepository(this.db),
      fastifyOptions: { logger: false },
    });
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
