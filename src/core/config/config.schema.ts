import { z } from 'zod';

export const modelTierSchema = z.object({
  provider: z.enum(['gemini', 'anthropic']),
  model: z.string(),
  thinking: z.boolean().default(false),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

export const configSchema = z.object({
  server: z
    .object({
      port: z.coerce.number().default(8080),
      concurrency: z.coerce.number().default(2),
    })
    .prefault({}),
  github: z.object({
    appId: z.string().min(1),
    privateKeyBase64: z.string().min(1),
    webhookSecret: z.string().min(1),
    reposAllowlist: z.array(z.string()).default([]),
  }),
  triggers: z
    .object({
      onOpened: z.boolean().default(true),
      onReadyForReview: z.boolean().default(true),
      reviewCommand: z.string().default('/review'),
      maxFindings: z.coerce.number().default(12),
    })
    .prefault({}),
  models: z.object({
    tiers: z.record(z.string(), modelTierSchema),
    agents: z.object({
      orchestrator: z.string().default('default'),
      ticketComparison: z.string().default('default'),
      codeProblems: z.string().default('thinking'),
      codeQuality: z.string().default('thinking'),
      contextSummarizer: z.string().default('thinking'),
      verifier: z.string().default('default'),
    }),
  }),
  verification: z
    .object({
      enabled: z.boolean().default(true),
      concurrency: z.coerce.number().default(4),
    })
    .prefault({}),
  embeddings: z
    .object({
      model: z.string().default('gemini-embedding-001'),
      dimensions: z.coerce.number().default(1536),
    })
    .prefault({}),
  cache: z
    .object({
      redisUrl: z.string().default('redis://localhost:6379'),
      repoContextTtlSeconds: z.coerce.number().default(7 * 24 * 3600),
      // Rebuild the whole-repo context once the newest cached doc is older
      // than this; between rebuilds all reviews share the same doc.
      repoContextMaxAgeSeconds: z.coerce.number().default(24 * 3600),
    })
    .prefault({}),
  context: z
    .object({
      maxChunkTokens: z.coerce.number().default(60_000),
      maxChunks: z.coerce.number().default(40),
      summaryConcurrency: z.coerce.number().default(5),
      extraIgnores: z.array(z.string()).default([]),
      // Budgets for full changed-file content shown to reviewer agents.
      maxChangedFileTokens: z.coerce.number().default(8_000),
      changedFilesTokenBudget: z.coerce.number().default(48_000),
    })
    .prefault({}),
  discussions: z
    .object({
      databaseUrl: z.string().default('postgres://postgres:postgres@localhost:5432/reviews'),
      searchLimit: z.coerce.number().default(8),
    })
    .prefault({}),
  skills: z
    .object({
      // Directory containing the code-review skill (SKILL.md + references/),
      // e.g. a checkout of usermeme/skills/code-review. Empty = embedded snapshot.
      codeReviewDir: z.string().default(''),
    })
    .prefault({}),
  tickets: z
    .object({
      jira: z
        .object({
          enabled: z.boolean().default(false),
          baseUrl: z.string().default(''),
          email: z.string().default(''),
          apiToken: z.string().default(''),
        })
        .prefault({}),
      clickup: z
        .object({
          enabled: z.boolean().default(false),
          apiToken: z.string().default(''),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type AppConfig = z.infer<typeof configSchema>;
export type ModelTier = z.infer<typeof modelTierSchema>;
