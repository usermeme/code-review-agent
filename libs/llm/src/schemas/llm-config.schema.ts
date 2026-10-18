import { z } from 'zod';

export const geminiLlmConfigSchema = z.object({
  LLM_PROVIDER: z.literal('gemini').default('gemini'),
  REVIEW_MODEL: z.string().min(1),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
});

export const mockLlmConfigSchema = z.object({
  LLM_PROVIDER: z.literal('mock'),
  REVIEW_MODEL: z.string().optional(),
});

export const llmConfigSchema = z.discriminatedUnion('LLM_PROVIDER', [
  geminiLlmConfigSchema,
  mockLlmConfigSchema,
]);

export type LlmConfig = z.infer<typeof llmConfigSchema>;
