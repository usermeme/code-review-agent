import { z } from 'zod';
import { EnvService } from 'env';

export const codeReviewerEnvSchema = z.object({
  CORE_URL: z.string().min(1),
  REVIEW_MODEL: z.string().min(1),
  REVIEW_RESULT_TOPIC: z.string().min(1),
  INTERNAL_AUTH_TOKEN: z.string().min(1),
  HOST: z.string().optional().default('0.0.0.0'),
  PORT: z.string().optional().default('8080'),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_GENAI_USE_VERTEXAI: z.string().optional(),
});

export type CodeReviewerEnvSchema = typeof codeReviewerEnvSchema;
export type CodeReviewerEnvService = EnvService<CodeReviewerEnvSchema>;

export const envService: CodeReviewerEnvService = new EnvService(
  codeReviewerEnvSchema,
);
