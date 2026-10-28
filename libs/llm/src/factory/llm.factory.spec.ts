import { Gemini } from '@google/adk';
import { describe, expect, it } from 'vitest';

import { MockLlm } from '../providers/mock.llm.js';
import { RetryingLlm } from '../providers/retrying.llm.js';
import { llmConfigSchema } from '../schemas/llm-config.schema.js';
import { LlmFactory } from './llm.factory.js';

describe('LlmFactory', () => {
  it('creates a rate-limit-retrying Gemini LLM instance when provider is gemini', () => {
    const config = llmConfigSchema.parse({
      LLM_PROVIDER: 'gemini',
      REVIEW_MODEL: 'gemini-2.5-flash',
      GEMINI_API_KEY: 'test-key',
    });

    const factory = new LlmFactory(config);
    const llm = factory.createLlm();

    expect(llm).toBeInstanceOf(RetryingLlm);
    expect((llm as RetryingLlm).inner).toBeInstanceOf(Gemini);
    expect(llm.model).toBe('gemini-2.5-flash');
  });

  it('defaults LLM_PROVIDER to gemini when omitted', () => {
    const config = llmConfigSchema.parse({
      REVIEW_MODEL: 'gemini-3.8-flash',
      GEMINI_API_KEY: 'test-key',
    });

    expect(config.LLM_PROVIDER).toBe('gemini');
    const llm = new LlmFactory(config).createLlm();
    expect(llm).toBeInstanceOf(RetryingLlm);
    expect((llm as RetryingLlm).inner).toBeInstanceOf(Gemini);
    expect(llm.model).toBe('gemini-3.8-flash');
  });

  it('creates a MockLlm instance when provider is mock', () => {
    const config = llmConfigSchema.parse({
      LLM_PROVIDER: 'mock',
      REVIEW_MODEL: 'test-model',
    });

    const llm = new LlmFactory(config).createLlm();
    expect(llm).toBeInstanceOf(MockLlm);
    expect(llm.model).toBe('test-model');
  });

  it('supports modelOverride in factory.createLlm', () => {
    const config = llmConfigSchema.parse({
      LLM_PROVIDER: 'gemini',
      REVIEW_MODEL: 'gemini-2.5-flash',
      GEMINI_API_KEY: 'test-key',
    });

    const llm = new LlmFactory(config).createLlm({
      modelOverride: 'gemini-2.5-pro',
    });
    expect(llm.model).toBe('gemini-2.5-pro');
  });
});
