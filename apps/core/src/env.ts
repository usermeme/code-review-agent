import { EnvService } from '@code-review-agent/env';
import {
  geminiLlmConfigSchema,
  mockLlmConfigSchema,
} from '@code-review-agent/llm';
import { z } from 'zod';

const coreBaseEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GIT_ADAPTER_URL: z.string().min(1),
  REVIEW_RESULTS_TOPIC: z.string().min(1),
  /**
   * Optional cheaper/faster model for the per-chunk summarization map-step of
   * context builds. When unset, REVIEW_MODEL is used for everything.
   */
  CONTEXT_SUMMARY_MODEL: z.string().min(1).optional(),
});

export const coreEnvSchema = z.discriminatedUnion('LLM_PROVIDER', [
  coreBaseEnvSchema.merge(geminiLlmConfigSchema),
  coreBaseEnvSchema.merge(mockLlmConfigSchema),
]);

export type CoreEnvService = EnvService<typeof coreEnvSchema>;

export const envService: CoreEnvService = new EnvService(coreEnvSchema);
