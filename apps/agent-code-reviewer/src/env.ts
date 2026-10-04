import { z } from 'zod';
import { EnvService } from 'env';

export const codeReviewerEnvSchema = z.object({
  CORE_URL: z.string().min(1),
  REVIEW_MODEL: z.string().min(1),
  REVIEW_RESULT_TOPIC: z.string().min(1),
  PUBSUB_SECRET_TOKEN: z.string().min(1),
  PORT: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_GENAI_USE_VERTEXAI: z.string().optional(),
});

export type CodeReviewerEnvSchema = typeof codeReviewerEnvSchema;
export type CodeReviewerEnvService = EnvService<CodeReviewerEnvSchema>;

export const envService: CodeReviewerEnvService = new EnvService(codeReviewerEnvSchema);
