import Fastify from 'fastify';
import { webhooksModule } from './modules/webhooks/webhooks.module.js';
import { contextModule } from './modules/context/context.module.js';
import { reviewModule } from './modules/review/review.module.js';
import { internalModule } from './modules/internal/internal.module.js';
import { FirestoreDatabaseService } from './modules/database/firestore.service.js';
import { PrRepository } from './modules/database/repositories/pr.repository.js';
import { ContextRepository } from './modules/database/repositories/context.repository.js';
import { GitService } from './modules/git/git.service.js';
import { GithubAdapter } from './modules/git/adapters/github.adapter.js';

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
const contextRepository = new ContextRepository(databaseService);

const gitService = new GitService();
gitService.registerAdapter('github', new GithubAdapter(prRepository));
await gitService.initAdapters(server.log);

server.register(webhooksModule, { prefix: '/api/v1', gitService });
server.register(internalModule, {
  prefix: '/api/v1/internal',
  prRepository,
  contextRepository,
});
server.register(contextModule, { prefix: '/api/v1', contextRepository });
server.register(reviewModule, { prefix: '/api/v1', prRepository, gitService });

server.listen({ port, host }, (err) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  } else {
    console.log(`[ ready ] http://${host}:${port}`);
  }
});
