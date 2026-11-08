import { EnvService } from '@code-review-agent/env';
import { LlmFactory } from '@code-review-agent/llm';
import { IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildCoreServer } from '../../../core/src/app.js';
import { coreEnvSchema, CoreEnvService } from '../../../core/src/env.js';
import { GitAdapterClient } from '../../../core/src/modules/adapter/git-adapter.client.js';
import { DeliveryRepository } from '../../../core/src/modules/database/repositories/delivery.repository.js';
import { PrRepository } from '../../../core/src/modules/database/repositories/pr.repository.js';
import { InMemoryDatabaseService } from '../../../core/src/modules/database/testing/in-memory-database.service.js';
import { EventOrchestratorService } from '../../../core/src/services/event-orchestrator.service.js';
import { MockPubSub } from './doubles/mock-pubsub.js';

export class CoreWorld extends World {
  public app!: FastifyInstance;
  public db: InMemoryDatabaseService;
  public pubsub: MockPubSub;
  public prRepository: PrRepository;
  public orchestrator!: EventOrchestratorService;
  public envService!: CoreEnvService;
  public lastResponse?: LightMyRequestResponse;

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
      LLM_PROVIDER: 'mock',
      REVIEW_MODEL: 'test-model',
      GIT_ADAPTER_URL: 'http://adapter:8080',
    });

    const gitAdapterClient = new GitAdapterClient(
      this.envService.get('GIT_ADAPTER_URL'),
    );
    const llm = new LlmFactory(this.envService.data).createLlm();

    this.orchestrator = new EventOrchestratorService({
      pubsub: this.pubsub as unknown as PubSub,
      prRepository: this.prRepository,
      envService: this.envService,
      gitAdapterClient,
      llm,
    });

    this.app = await buildCoreServer({
      databaseService: this.db,
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
