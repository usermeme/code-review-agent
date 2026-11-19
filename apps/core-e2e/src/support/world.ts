import { EnvService } from '@code-review-agent/env';
import { createMockAgentModels } from '@code-review-agent/llm';
import { IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildCoreServer } from '../../../core/src/app.js';
import { coreEnvSchema, CoreEnvService } from '../../../core/src/env.js';
import { DeliveryRepository } from '../../../core/src/modules/database/repositories/delivery.repository.js';
import { PrRepository } from '../../../core/src/modules/database/repositories/pr.repository.js';
import { ThreadJudgmentRepository } from '../../../core/src/modules/database/repositories/thread-judgment.repository.js';
import { InMemoryDatabaseService } from '../../../core/src/modules/database/testing/in-memory-database.service.js';
import { CommentJudgeService } from '../../../core/src/services/comment-judge/comment-judge.service.js';
import { EventOrchestratorService } from '../../../core/src/services/event-orchestrator.service.js';
import { InMemoryGitAdapterClient } from './doubles/in-memory-git-adapter.js';
import { JudgeLlm } from './doubles/judge-llm.js';
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
  public judgeLlm = new JudgeLlm();
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
    const deliveryRepository = new DeliveryRepository(this.db);
    const reviewResultsTopic = this.envService.get('REVIEW_RESULTS_TOPIC');
    const commentJudge = new CommentJudgeService({
      gitAdapterClient,
      judgments: new ThreadJudgmentRepository(this.db),
      claims: deliveryRepository,
      prRepository: this.prRepository,
      model: this.judgeLlm,
      publish: async (payload) => {
        await this.pubsub.topic(reviewResultsTopic).publishMessage({
          json: payload as unknown as Record<string, unknown>,
        });
      },
    });

    this.orchestrator = new EventOrchestratorService({
      pubsub: this.pubsub as unknown as PubSub,
      prRepository: this.prRepository,
      envService: this.envService,
      gitAdapterClient,
      models: createMockAgentModels(),
      commentJudge,
    });

    this.app = await buildCoreServer({
      databaseService: this.db,
      orchestrator: this.orchestrator,
      deliveryRepository,
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
  }
}

setWorldConstructor(CoreWorld);
