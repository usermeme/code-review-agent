import { z } from 'zod';
import { EnvService } from 'env';

export const contextBuilderEnvSchema = z.object({
  CORE_URL: z.string().min(1),
  REVIEW_MODEL: z.string().min(1),
  CONTEXT_READY_TOPIC: z.string().min(1),
  GIT_ADAPTER_TOKEN: z.string().optional(),
  PORT: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_GENAI_USE_VERTEXAI: z.string().optional(),
});

export type ContextBuilderEnvSchema = typeof contextBuilderEnvSchema;
export type ContextBuilderEnvService = EnvService<ContextBuilderEnvSchema>;

export const envService: ContextBuilderEnvService = new EnvService(contextBuilderEnvSchema);
