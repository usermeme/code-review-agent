import { type BaseLlm, Gemini } from '@google/adk';

import { MockLlm } from '../providers/mock.llm.js';
import { withLlmRetry } from '../providers/retrying.llm.js';
import type { LlmConfig } from '../schemas/llm-config.schema.js';

export interface CreateLlmOptions {
  modelOverride?: string;
}

export class LlmFactory {
  constructor(private readonly config: LlmConfig) {}

  createLlm(options: CreateLlmOptions = {}): BaseLlm {
    const model = this.resolveModel(options);

    switch (this.config.LLM_PROVIDER) {
      case 'gemini': {
        // Wrapped so every caller (review agent, context-builder chunk
        // summaries) absorbs rate limits and transient 5xx/network failures
        // with exponential backoff + jitter instead of failing the whole run —
        // required now that LLM calls are dispatched concurrently.
        return withLlmRetry(
          new Gemini({
            model,
            apiKey: this.config.GEMINI_API_KEY,
            project: this.config.GOOGLE_CLOUD_PROJECT,
          }),
        );
      }
      case 'mock': {
        return new MockLlm({ model });
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
