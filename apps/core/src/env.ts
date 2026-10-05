import { z } from 'zod';
import { EnvService } from 'env';

export const coreEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GATEWAY_URL: z.string().min(1),
  INTERNAL_AUTH_TOKEN: z.string().min(1),
  BUILD_CONTEXT_TOPIC: z.string().min(1),
  REVIEW_CODE_TOPIC: z.string().min(1),
  CONTEXT_READY_TOPIC: z.string().optional(),
  REVIEW_RESULT_TOPIC: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
});

export type CoreEnvSchema = typeof coreEnvSchema;
export type CoreEnvService = EnvService<CoreEnvSchema>;

export const envService: CoreEnvService = new EnvService(coreEnvSchema);
