import Fastify from 'fastify';
import { webhooksModule } from './modules/webhooks/webhooks.module.js';
import { contextModule } from './modules/context/context.module.js';
import { reviewModule } from './modules/review/review.module.js';
import { internalModule } from './modules/internal/internal.module.js';
import { FirestoreDatabaseService } from './modules/database/firestore.service.js';
import { PrRepository } from './modules/database/repositories/pr.repository.js';

import fastifyRawBody from 'fastify-raw-body';

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

const server = Fastify({
  logger: true,
});

server.register(fastifyRawBody, {
  field: 'rawBody',
  global: false,
  encoding: 'utf8',
  runFirst: true,
});

// Initialize singletons (Composition Root)
const databaseService = new FirestoreDatabaseService();
await databaseService.connect();

const prRepository = new PrRepository(databaseService);

server.register(webhooksModule, { prefix: '/api/v1', prRepository });
server.register(internalModule, { prefix: '/api/v1/internal', prRepository });
server.register(contextModule, { prefix: '/api/v1' });
server.register(reviewModule, { prefix: '/api/v1' });

server.listen({ port, host }, (err) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  } else {
    console.log(`[ ready ] http://${host}:${port}`);
  }
});
