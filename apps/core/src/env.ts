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
  /**
   * Hard wall-clock limit for one in-process review run (ms). Must stay under
   * the Pub/Sub push ack deadline (600s) with room for diff fetch + baseline
   * resolution — capped at 540s so a review can never push the total request
   * past the ack deadline (which would redeliver the event mid-review and
   * double the LLM spend). Defaults to the library's 480s when unset.
   */
  REVIEW_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(540_000)
    .optional(),
});

export const coreEnvSchema = z.discriminatedUnion('LLM_PROVIDER', [
  coreBaseEnvSchema.merge(geminiLlmConfigSchema),
  coreBaseEnvSchema.merge(mockLlmConfigSchema),
]);

export type CoreEnvService = EnvService<typeof coreEnvSchema>;

export const envService: CoreEnvService = new EnvService(coreEnvSchema);
