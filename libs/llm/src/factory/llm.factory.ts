import { type BaseLlm, Gemini } from '@google/adk';

import { MockLlm } from '../providers/mock.llm.js';
import type { LlmConfig } from '../schemas/llm-config.schema.js';

export interface CreateLlmOptions {
  modelOverride?: string;
}

/** Mock provider fallback when no model name was configured or overridden. */
function resolveMockModel(model: string | undefined): string {
  return model || 'mock-model';
}

export class LlmFactory {
  constructor(private readonly config: LlmConfig) {}

  createLlm(options: CreateLlmOptions = {}): BaseLlm {
    const model = this.resolveModel(options);

    switch (this.config.LLM_PROVIDER) {
      case 'gemini': {
        return new Gemini({
          model,
          apiKey: this.config.GEMINI_API_KEY,
          project: this.config.GOOGLE_CLOUD_PROJECT,
        });
      }
      case 'mock': {
        return new MockLlm({
          model: resolveMockModel(model),
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

  /** Explicit per-call override wins; otherwise the configured review model. */
  private resolveModel(options: CreateLlmOptions): string | undefined {
    return options.modelOverride || this.config.REVIEW_MODEL;
  }
}
