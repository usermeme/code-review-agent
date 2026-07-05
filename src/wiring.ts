import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { App } from 'octokit';
import { createRedis } from './core/redis/redis.service.js';
import type { AppConfig } from './core/config/config.schema.js';
import { RepoContextBuilder } from './modules/context/repo-context-builder.service.js';
import { createPool, runMigrations } from './modules/discussion/db.service.js';
import { GeminiEmbedder } from './modules/discussion/embeddings.service.js';
import { DiscussionStore } from './modules/discussion/store.service.js';
import { createGithubApp } from './integrations/github/app-auth.service.js';
import { resolveModelInstance } from './integrations/model/model-config.service.js';
import { registerModels } from './integrations/model/registry.service.js';
import { createProviders, type TicketProvider } from './integrations/ticket/ticket.service.js';
import type { ReviewDeps } from './modules/review/review.service.js';
import { RepoContextCache } from './modules/context/repo-context-cache.service.js';

export interface Services {
  cfg: AppConfig;
  redis: Redis;
  pool: pg.Pool;
  app: App;
  discussionStore: DiscussionStore;
  contextBuilder: RepoContextBuilder;
  ticketProviders: TicketProvider[];
  reviewDeps: ReviewDeps;
  close: () => Promise<void>;
}

export async function buildServices(cfg: AppConfig): Promise<Services> {
  registerModels();
  const redis = createRedis(cfg.cache.redisUrl);
  const pool = createPool(cfg.discussions.databaseUrl);
  await runMigrations(pool);
  const embedder = new GeminiEmbedder(cfg.embeddings.model, cfg.embeddings.dimensions);
  const discussionStore = new DiscussionStore(pool, embedder);
  const cache = new RepoContextCache(redis, cfg.cache.repoContextTtlSeconds, cfg.cache.repoContextMaxAgeSeconds);
  const contextBuilder = new RepoContextBuilder(
    cache,
    resolveModelInstance(cfg, cfg.models.agents.contextSummarizer),
    cfg.context,
  );
  const app = createGithubApp(cfg);
  const ticketProviders = createProviders(cfg);
  return {
    cfg,
    redis,
    pool,
    app,
    discussionStore,
    contextBuilder,
    ticketProviders,
    reviewDeps: { cfg, app, contextBuilder, discussionStore, ticketProviders },
    close: async () => {
      redis.disconnect();
      await pool.end();
    },
  };
}
