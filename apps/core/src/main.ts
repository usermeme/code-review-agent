import { PubSub } from '@google-cloud/pubsub';
import { envService } from './env.js';
import { buildCoreServer } from './app.js';
import { FirestoreDatabaseService } from './modules/database/firestore.service.js';
import { PrRepository } from './modules/database/repositories/pr.repository.js';
import { ContextRepository } from './modules/database/repositories/context.repository.js';
import { AgentService } from './services/agent.service.js';
import { EventOrchestratorService } from './services/event-orchestrator.service.js';
import { PrEventsConsumer } from './modules/pubsub/pr-events.consumer.js';

const host = envService.get('HOST');
const port = envService.get('PORT');

const pubsub = new PubSub();
const databaseService = new FirestoreDatabaseService();
const prRepository = new PrRepository(databaseService);
const contextRepository = new ContextRepository(databaseService);
const agentService = new AgentService();

const orchestrator = new EventOrchestratorService({
  envService,
  pubsub,
  prRepository,
  contextRepository,
  agentService,
});

const server = await buildCoreServer({
  envService,
  contextRepository,
  fastifyOptions: { logger: true },
});

await databaseService.connect(server.log);

const consumer = new PrEventsConsumer({
  pubsub,
  subscriptionName: envService.get('PR_EVENTS_SUBSCRIPTION'),
  orchestrator,
  logger: server.log,
});
consumer.start();

server.addHook('onClose', async () => {
  await consumer.stop();
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
