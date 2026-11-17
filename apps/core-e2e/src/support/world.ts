import { EnvService } from '@code-review-agent/env';
import { createMockAgentModels, MockLlm } from '@code-review-agent/llm';
import { IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildCoreServer } from '../../../core/src/app.js';
import { coreEnvSchema, CoreEnvService } from '../../../core/src/env.js';
import { DeliveryRepository } from '../../../core/src/modules/database/repositories/delivery.repository.js';
import { PrRepository } from '../../../core/src/modules/database/repositories/pr.repository.js';
import { ReviewContextRepository } from '../../../core/src/modules/database/repositories/review-context.repository.js';
import { InMemoryDatabaseService } from '../../../core/src/modules/database/testing/in-memory-database.service.js';
import { EventOrchestratorService } from '../../../core/src/services/event-orchestrator.service.js';
import { ReviewContextService } from '../../../core/src/services/review-context.service.js';
import { InMemoryGitAdapterClient } from './doubles/in-memory-git-adapter.js';
import { MockPubSub } from './doubles/mock-pubsub.js';

export class CoreWorld extends World {
  public app!: FastifyInstance;
  public db: InMemoryDatabaseService;
  public pubsub: MockPubSub;
  public prRepository: PrRepository;
  public orchestrator!: EventOrchestratorService;
  public envService!: CoreEnvService;
  public lastResponse?: LightMyRequestResponse;
  public gitAdapterClient = new InMemoryGitAdapterClient();
  /** Rules the review-context builder returns, as its JSON answer. */
  public builderRules: Record<string, unknown>[] = [];
  private deliveryCount = 0;

  constructor(options: IWorldOptions) {
    super(options);
    this.db = new InMemoryDatabaseService();
    this.pubsub = new MockPubSub();
    this.prRepository = new PrRepository(this.db);
  }

  async initApp(): Promise<void> {
    this.envService = new EnvService(coreEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      REVIEW_RESULTS_TOPIC: 'test-review-results-topic',
      REVIEWER_MODEL: 'test-reviewer-model',
      VERIFIER_MODEL: 'test-verifier-model',
      GIT_ADAPTER_URL: 'http://adapter:8080',
    });

    const gitAdapterClient = this.gitAdapterClient;
    const builder = new MockLlm({
      model: 'mock-context-builder',
      generateResponse: () => ({ rules: this.builderRules }),
    });

    this.orchestrator = new EventOrchestratorService({
      pubsub: this.pubsub as unknown as PubSub,
      prRepository: this.prRepository,
      envService: this.envService,
      gitAdapterClient,
      models: createMockAgentModels(),
      reviewContextService: new ReviewContextService({
        gitAdapterClient,
        repository: new ReviewContextRepository(this.db),
        model: builder,
      }),
    });

    this.app = await buildCoreServer({
      databaseService: this.db,
      orchestrator: this.orchestrator,
      deliveryRepository: new DeliveryRepository(this.db),
      fastifyOptions: { logger: false },
    });
  }

  /** A Pub/Sub message id unique within the scenario. */
  nextMessageId(): string {
    this.deliveryCount += 1;
    return `msg-${Date.now()}-${this.deliveryCount}`;
  }

  async cleanup(): Promise<void> {
    if (this.app) {
      await this.app.close();
    }
    this.db.clear();
    this.pubsub.clear();
    this.gitAdapterClient.baseFiles.clear();
    this.builderRules = [];
  }
}

setWorldConstructor(CoreWorld);
