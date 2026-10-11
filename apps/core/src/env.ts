import { z } from 'zod';
import { EnvService } from 'env';

export const coreEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GIT_ADAPTER_URL: z.string().min(1),
  REVIEW_RESULTS_TOPIC: z.string().min(1),
  REVIEW_MODEL: z.string().min(1),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
});

export type CoreEnvSchema = typeof coreEnvSchema;
export type CoreEnvService = EnvService<CoreEnvSchema>;

export const envService: CoreEnvService = new EnvService(coreEnvSchema);
