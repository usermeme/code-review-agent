import { type BaseLlm, Gemini } from '@google/adk';

import { MockLlm } from '../providers/mock.llm.js';
import { OllamaLlm } from '../providers/ollama.llm.js';
import { OpenAiLlm } from '../providers/openai.llm.js';
import type { LlmConfig } from '../schemas/llm-config.schema.js';

export interface CreateLlmOptions {
  modelOverride?: string;
}

export class LlmFactory {
  constructor(private readonly config: LlmConfig) {}

  createLlm(options: CreateLlmOptions = {}): BaseLlm {
    const model = options.modelOverride || this.config.REVIEW_MODEL;

    switch (this.config.LLM_PROVIDER) {
      case 'gemini': {
        return new Gemini({
          model,
          apiKey: this.config.GEMINI_API_KEY,
          project: this.config.GOOGLE_CLOUD_PROJECT,
        });
      }
      case 'openai': {
        return new OpenAiLlm({
          model: model || 'gpt-4o',
          apiKey: this.config.OPENAI_API_KEY,
          baseUrl: this.config.OPENAI_BASE_URL,
        });
      }
      case 'ollama': {
        return new OllamaLlm({
          model: model || 'llama3',
          baseUrl: this.config.OLLAMA_BASE_URL,
          apiKey: this.config.OLLAMA_API_KEY,
        });
      }
      case 'mock': {
        return new MockLlm({
          model: model || 'mock-model',
        });
      }
      default: {
        const unreachable: never = this.config;
        throw new Error(
          `Unsupported LLM provider: ${JSON.stringify(unreachable)}`,
        );
      }
    }
  }
}

export function createLlm(
  config: LlmConfig,
  options?: CreateLlmOptions,
): BaseLlm {
  return new LlmFactory(config).createLlm(options);
}
