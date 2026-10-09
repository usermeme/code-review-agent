import { z } from 'zod';
import { EnvService } from 'env';

export const coreEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  PR_EVENTS_SUBSCRIPTION: z.string().min(1).default('pr-events-sub'),
  REVIEW_RESULTS_TOPIC: z.string().min(1).default('review-results'),
  REVIEW_MODEL: z.string().optional().default('gemini-2.5-flash'),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
});

export type CoreEnvSchema = typeof coreEnvSchema;
export type CoreEnvService = EnvService<CoreEnvSchema>;

export const envService: CoreEnvService = new EnvService(coreEnvSchema);
