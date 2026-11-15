import { EnvService } from '@code-review-agent/env';
import { modelConfigSchema } from '@code-review-agent/llm';
import { z } from 'zod';

const coreBaseEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GIT_ADAPTER_URL: z.string().min(1),
  REVIEW_RESULTS_TOPIC: z.string().min(1),
  /**
   * Hard wall-clock limit for one in-process review run (ms). Must stay under
   * the Pub/Sub push ack deadline (600s) with room for diff fetch — capped at
   * 540s so a review can never push the total request past the ack deadline.
   */
  REVIEW_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(540_000)
    .optional(),
  /**
   * Comma-separated globs of paths that always get a deep review (e.g.
   * `**\/auth/**,**\/migrations/**`). Unset uses the review-agent defaults.
   */
  DEEP_REVIEW_PATHS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(',')
        .map((pattern) => pattern.trim())
        .filter(Boolean),
    ),
});

export const coreEnvSchema = coreBaseEnvSchema.merge(modelConfigSchema);

export type CoreEnvService = EnvService<typeof coreEnvSchema>;

export const envService: CoreEnvService = new EnvService(coreEnvSchema);
