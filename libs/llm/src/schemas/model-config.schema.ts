import { z } from 'zod';

/**
 * Default model for the triage role. Infra may override it with
 * `TRIAGE_MODEL`; the reviewer and verifier models have no default because
 * infra decides which Gemini tier each role runs on.
 */
export const DEFAULT_TRIAGE_MODEL = 'gemini-decision-1';

const modelId = z.string().trim().min(1);

export const modelConfigSchema = z.object({
  /** Cheap decision model: routes PRs and answers yes/no and choice questions. */
  TRIAGE_MODEL: modelId.default(DEFAULT_TRIAGE_MODEL),
  /** Reads the diff and uses repo tools to propose findings (e.g. Gemini 4 Hydrogen). */
  REVIEWER_MODEL: modelId,
  /** Confirms or rejects proposed findings (e.g. Gemini 4 Argon or Carbon). */
  VERIFIER_MODEL: modelId,
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;
