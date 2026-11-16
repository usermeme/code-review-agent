import { type BaseLlm, Gemini } from '@google/adk';

import { withLlmRetry } from '../providers/retrying.llm.js';
import type { ModelConfig } from '../schemas/model-config.schema.js';

/** The agent roles in a review; each one runs on its own model. */
export type AgentRole = 'triage' | 'reviewer' | 'verifier';

/** One LLM per agent role. Tests pass `MockLlm` (or any `BaseLlm`) instances. */
export type AgentModels = Record<AgentRole, BaseLlm>;

function createGemini(model: string, config: ModelConfig): BaseLlm {
  // Every role absorbs rate limits and transient 5xx/network failures with
  // exponential backoff + jitter instead of failing the whole review.
  return withLlmRetry(
    new Gemini({
      model,
      apiKey: config.GEMINI_API_KEY,
      project: config.GOOGLE_CLOUD_PROJECT,
    }),
  );
}

/** Builds the retry-wrapped Gemini client for each agent role. */
export function createAgentModels(config: ModelConfig): AgentModels {
  return {
    triage: createGemini(config.TRIAGE_MODEL, config),
    reviewer: createGemini(config.REVIEWER_MODEL, config),
    verifier: createGemini(config.VERIFIER_MODEL, config),
  };
}
