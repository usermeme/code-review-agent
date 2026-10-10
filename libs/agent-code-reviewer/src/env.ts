import { z } from 'zod';
import { EnvService } from 'env';

export const codeReviewerEnvSchema = z.object({
  REVIEW_MODEL: z.string().optional().default('gemini-2.5-flash'),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_GENAI_USE_VERTEXAI: z.string().optional(),
});

export type CodeReviewerEnvSchema = typeof codeReviewerEnvSchema;
export type CodeReviewerEnvService = EnvService<CodeReviewerEnvSchema>;

export const envService: CodeReviewerEnvService = new EnvService(
  codeReviewerEnvSchema,
);
