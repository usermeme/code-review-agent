import { LlmFactory } from '@code-review-agent/llm';
import { Firestore } from '@google-cloud/firestore';
import { PubSub } from '@google-cloud/pubsub';

import { buildCoreServer } from './app.js';
import { envService } from './env.js';
import { GitAdapterClient } from './modules/adapter/git-adapter.client.js';
import { FirestoreDatabaseService } from './modules/database/firestore.service.js';
import { BaselineLockRepository } from './modules/database/repositories/baseline-lock.repository.js';
import { ContextRepository } from './modules/database/repositories/context.repository.js';
import { DeliveryRepository } from './modules/database/repositories/delivery.repository.js';
import { PrRepository } from './modules/database/repositories/pr.repository.js';
import { AgentService } from './services/agent.service.js';
import { EventOrchestratorService } from './services/event-orchestrator.service.js';

async function bootstrap() {
  const host = envService.get('HOST');
  const port = envService.get('PORT');

  const firestore = new Firestore();
  const pubsub = new PubSub();
  const databaseService = new FirestoreDatabaseService({ firestore });
  const prRepository = new PrRepository(databaseService);
  const contextRepository = new ContextRepository(databaseService);
  const deliveryRepository = new DeliveryRepository(databaseService);
  const baselineLockRepository = new BaselineLockRepository(databaseService);
  const agentService = new AgentService();
  const gitAdapterClient = new GitAdapterClient(
    envService.get('GIT_ADAPTER_URL'),
  );
  const llmFactory = new LlmFactory(envService.data);
  const llm = llmFactory.createLlm();
  const summaryModel = envService.get('CONTEXT_SUMMARY_MODEL');
  const summaryLlm = summaryModel
    ? llmFactory.createLlm({
        modelOverride: summaryModel,
      })
    : undefined;

  const orchestrator = new EventOrchestratorService({
    envService,
    pubsub,
    prRepository,
    contextRepository,
    baselineLockRepository,
    agentService,
    gitAdapterClient,
    llm,
    summaryLlm,
  });

  const server = await buildCoreServer({
    databaseService,
    contextRepository,
    orchestrator,
    deliveryRepository,
    fastifyOptions: { logger: true },
  });

  try {
    await server.listen({ port, host });
    server.log.info(`[ Core ready ] http://${host}:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, () => {
      void (async () => {
        server.log.info(`Received ${signal}, shutting down gracefully...`);
        try {
          await server.close();
          server.log.info('Server shutdown complete.');
          process.exit(0);
        } catch (err) {
          server.log.error(err, 'Error during shutdown');
          process.exit(1);
        }
      })();
    });
  }
}

void bootstrap();
