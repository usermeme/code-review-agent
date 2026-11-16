import { type BaseLlm, Gemini } from '@google/adk';

import { withLlmRetry } from '../providers/retrying.llm.js';
import type { ModelConfig } from '../schemas/model-config.schema.js';

/** The agent roles in a review; each one runs on its own model. */
export type AgentRole = 'triage' | 'reviewer' | 'verifier';

/** One LLM per agent role. Tests pass `MockLlm` (or any `BaseLlm`) instances. */
export type AgentModels = Record<AgentRole, BaseLlm>;

/**
 * Gemini Developer API version the agents call. @google/genai 3 changed the
 * default from v1beta to v1, but ADK builds its client without an
 * apiVersion, and preview models and the Decisions API live on v1beta.
 */
export const GEMINI_API_VERSION = 'v1beta';

/**
 * Pins the genai client's API version through GOOGLE_GENAI_API_VERSION, the
 * only hook ADK leaves (it reads the variable when its client is first
 * built). An explicit value in the environment wins.
 */
function pinGeminiApiVersion(): void {
  process.env['GOOGLE_GENAI_API_VERSION'] ??= GEMINI_API_VERSION;
}

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
  pinGeminiApiVersion();
  return {
    triage: createGemini(config.TRIAGE_MODEL, config),
    reviewer: createGemini(config.REVIEWER_MODEL, config),
    verifier: createGemini(config.VERIFIER_MODEL, config),
  };
}
