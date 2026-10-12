import { EnvService } from '@code-review-agent/env';
import {
  geminiLlmConfigSchema,
  mockLlmConfigSchema,
} from '@code-review-agent/llm';
import { z } from 'zod';

export const coreBaseEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GIT_ADAPTER_URL: z.string().min(1),
  REVIEW_RESULTS_TOPIC: z.string().min(1),
});

export const coreEnvSchema = z.discriminatedUnion('LLM_PROVIDER', [
  coreBaseEnvSchema.merge(geminiLlmConfigSchema),
  coreBaseEnvSchema.merge(mockLlmConfigSchema),
]);

export type CoreEnvSchema = typeof coreEnvSchema;
export type CoreEnv = z.infer<CoreEnvSchema>;
export type CoreEnvService = EnvService<CoreEnvSchema>;

export const envService: CoreEnvService = new EnvService(coreEnvSchema);
