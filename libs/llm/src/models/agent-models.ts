import { type BaseLlm, Gemini } from '@google/adk';
import { GoogleGenAI } from '@google/genai';

import {
  type DecisionModel,
  GeminiDecisionModel,
} from '../decisions/decision-model.js';
import { withLlmRetry } from '../providers/retrying.llm.js';
import type { ModelConfig } from '../schemas/model-config.schema.js';

/** The agent roles in a review; each one runs on its own model. */
export type AgentRole = 'triage' | 'reviewer' | 'verifier';

/**
 * One model per agent role. Triage (routing and dedupe) answers structured
 * questions on a decision model; the reviewer and verifier are ADK agents.
 * Tests pass `MockDecisionModel` and `MockLlm` (or any `BaseLlm`) instances.
 */
export interface AgentModels {
  triage: DecisionModel;
  reviewer: BaseLlm;
  verifier: BaseLlm;
}

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

/**
 * The Decisions API is only on the Gemini Developer API, so this client
 * always uses an API key (genai falls back to GEMINI_API_KEY/GOOGLE_API_KEY).
 * The SDK retries 408/409/429/5xx with backoff on its own.
 */
function createDecisionModel(config: ModelConfig): DecisionModel {
  const client = new GoogleGenAI({
    vertexai: false,
    apiKey: config.GEMINI_API_KEY,
    apiVersion: GEMINI_API_VERSION,
  });
  return new GeminiDecisionModel(
    client,
    config.TRIAGE_MODEL,
    GEMINI_API_VERSION,
  );
}

/** Builds the decision model for triage and a retry-wrapped Gemini per agent. */
export function createAgentModels(config: ModelConfig): AgentModels {
  pinGeminiApiVersion();
  return {
    triage: createDecisionModel(config),
    reviewer: createGemini(config.REVIEWER_MODEL, config),
    verifier: createGemini(config.VERIFIER_MODEL, config),
  };
}
