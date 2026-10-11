import { z } from 'zod';
import { EnvService } from 'env';

export const contextBuilderEnvSchema = z.object({
  REVIEW_MODEL: z.string().optional().default('gemini-3.8-flash'),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_GENAI_USE_VERTEXAI: z.string().optional(),
});

export type ContextBuilderEnvSchema = typeof contextBuilderEnvSchema;
export type ContextBuilderEnvService = EnvService<ContextBuilderEnvSchema>;

export const envService: ContextBuilderEnvService = new EnvService(
  contextBuilderEnvSchema,
);
