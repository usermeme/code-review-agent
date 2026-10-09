import { z } from 'zod';
import { EnvService } from 'env';

export const coreEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  PR_EVENTS_SUBSCRIPTION: z.string().min(1).default('pr-events-sub'),
  REVIEW_RESULTS_TOPIC: z.string().min(1).default('review-results'),
  BUILD_CONTEXT_TOPIC: z.string().optional().default('build-context-topic'),
  REVIEW_CODE_TOPIC: z.string().optional().default('review-code-topic'),
  CONTEXT_READY_TOPIC: z.string().optional(),
  REVIEW_RESULT_TOPIC: z.string().optional(),
  INTERNAL_AUTH_TOKEN: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
});

export type CoreEnvSchema = typeof coreEnvSchema;
export type CoreEnvService = EnvService<CoreEnvSchema>;

export const envService: CoreEnvService = new EnvService(coreEnvSchema);
