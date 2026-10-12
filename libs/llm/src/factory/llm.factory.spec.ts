import { Gemini } from '@google/adk';
import { describe, expect, it } from 'vitest';

import { MockLlm } from '../providers/mock.llm.js';
import { OllamaLlm } from '../providers/ollama.llm.js';
import { OpenAiLlm } from '../providers/openai.llm.js';
import { llmConfigSchema } from '../schemas/llm-config.schema.js';
import { createLlm, LlmFactory } from './llm.factory.js';

describe('LlmFactory', () => {
  it('creates a Gemini LLM instance when provider is gemini', () => {
    const config = llmConfigSchema.parse({
      LLM_PROVIDER: 'gemini',
      REVIEW_MODEL: 'gemini-2.5-flash',
      GEMINI_API_KEY: 'test-key',
    });

    const factory = new LlmFactory(config);
    const llm = factory.createLlm();

    expect(llm).toBeInstanceOf(Gemini);
    expect(llm.model).toBe('gemini-2.5-flash');
  });

  it('defaults LLM_PROVIDER to gemini when omitted', () => {
    const config = llmConfigSchema.parse({
      REVIEW_MODEL: 'gemini-3.8-flash',
      GEMINI_API_KEY: 'test-key',
    });

    expect(config.LLM_PROVIDER).toBe('gemini');
    const llm = createLlm(config);
    expect(llm).toBeInstanceOf(Gemini);
    expect(llm.model).toBe('gemini-3.8-flash');
  });

  it('creates an OpenAiLlm instance when provider is openai', () => {
    const config = llmConfigSchema.parse({
      LLM_PROVIDER: 'openai',
      REVIEW_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_BASE_URL: 'https://custom.openai.endpoint/v1',
    });

    const factory = new LlmFactory(config);
    const llm = factory.createLlm();

    expect(llm).toBeInstanceOf(OpenAiLlm);
    expect(llm.model).toBe('gpt-4o');
  });

  it('fails validation when openai provider is missing api key', () => {
    const result = llmConfigSchema.safeParse({
      LLM_PROVIDER: 'openai',
      REVIEW_MODEL: 'gpt-4o',
    });

    expect(result.success).toBe(false);
  });

  it('creates an OllamaLlm instance with defaults when provider is ollama', () => {
    const config = llmConfigSchema.parse({
      LLM_PROVIDER: 'ollama',
      REVIEW_MODEL: 'llama3.2',
    });

    const factory = new LlmFactory(config);
    const llm = factory.createLlm();

    expect(llm).toBeInstanceOf(OllamaLlm);
    expect(llm.model).toBe('llama3.2');
  });

  it('creates an OllamaLlm instance with custom base URL and api key', () => {
    const config = llmConfigSchema.parse({
      LLM_PROVIDER: 'ollama',
      REVIEW_MODEL: 'qwen2.5-coder:7b',
      OLLAMA_BASE_URL: 'http://my-ollama:11434',
      OLLAMA_API_KEY: 'secret-token',
    });

    const llm = createLlm(config);

    expect(llm).toBeInstanceOf(OllamaLlm);
    expect(llm.model).toBe('qwen2.5-coder:7b');
  });

  it('creates a MockLlm instance when provider is mock', () => {
    const config = llmConfigSchema.parse({
      LLM_PROVIDER: 'mock',
      REVIEW_MODEL: 'test-model',
    });

    const llm = createLlm(config);
    expect(llm).toBeInstanceOf(MockLlm);
    expect(llm.model).toBe('test-model');
  });

  it('supports modelOverride in createLlm', () => {
    const config = llmConfigSchema.parse({
      LLM_PROVIDER: 'gemini',
      REVIEW_MODEL: 'gemini-2.5-flash',
      GEMINI_API_KEY: 'test-key',
    });

    const llm = createLlm(config, { modelOverride: 'gemini-2.5-pro' });
    expect(llm.model).toBe('gemini-2.5-pro');
  });
});
