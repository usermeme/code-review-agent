import { z } from 'zod';

export const geminiLlmConfigSchema = z.object({
  LLM_PROVIDER: z.literal('gemini').default('gemini'),
  REVIEW_MODEL: z.string().min(1),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
});

export const openaiLlmConfigSchema = z.object({
  LLM_PROVIDER: z.literal('openai'),
  REVIEW_MODEL: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.string().optional(),
});

export const mockLlmConfigSchema = z.object({
  LLM_PROVIDER: z.literal('mock'),
  REVIEW_MODEL: z.string().optional(),
});

export const ollamaLlmConfigSchema = z.object({
  LLM_PROVIDER: z.literal('ollama'),
  REVIEW_MODEL: z.string().min(1),
  OLLAMA_BASE_URL: z.string().optional().default('http://localhost:11434'),
  OLLAMA_API_KEY: z.string().optional(),
});

export const llmConfigSchema = z.discriminatedUnion('LLM_PROVIDER', [
  geminiLlmConfigSchema,
  openaiLlmConfigSchema,
  ollamaLlmConfigSchema,
  mockLlmConfigSchema,
]);

export type GeminiLlmConfig = z.infer<typeof geminiLlmConfigSchema>;
export type OpenAiLlmConfig = z.infer<typeof openaiLlmConfigSchema>;
export type OllamaLlmConfig = z.infer<typeof ollamaLlmConfigSchema>;
export type MockLlmConfig = z.infer<typeof mockLlmConfigSchema>;
export type LlmConfig = z.infer<typeof llmConfigSchema>;
