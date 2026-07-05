import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { App } from 'octokit';
import { RepoContextCache, createRedis } from './cache/redis.js';
import type { AppConfig } from './config/schema.js';
import { RepoContextBuilder } from './context/repo-context-builder.js';
import { createPool, runMigrations } from './discussions/db.js';
import { GeminiEmbedder } from './discussions/embeddings.js';
import { DiscussionStore } from './discussions/store.js';
import { createGithubApp } from './github/app-auth.js';
import { resolveModelInstance } from './models/model-config.js';
import { registerModels } from './models/registry.js';
import { createProviders, type TicketProvider } from './tickets/provider.js';
import type { ReviewDeps } from './agents/run-review.js';

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
