import { LLMRegistry, type BaseLlm } from '@google/adk';
import type { AppConfig, ModelTier } from '../../core/config/config.schema.js';
import { ClaudeLlm } from './claude-llm.service.js';

function getTier(cfg: AppConfig, tierName: string): ModelTier {
  const tier = cfg.models.tiers[tierName];
  if (!tier) {
    throw new Error(
      `Unknown model tier "${tierName}"; configured tiers: ${Object.keys(cfg.models.tiers).join(', ')}`,
    );
  }
  return tier;
}

/**
 * Resolves a tier name to what LlmAgent's `model` option expects: a plain
 * string for Gemini (resolved by ADK's registry) or an explicit instance for
 * Claude so thinking/effort options are carried along.
 */
export function resolveModel(
  cfg: AppConfig,
  tierName: string,
): string | BaseLlm {
  const tier = getTier(cfg, tierName);
  if (tier.provider === 'gemini') return tier.model;
  return new ClaudeLlm({
    model: tier.model,
    thinking: tier.thinking,
    effort: tier.effort,
    maxTokens: tier.maxOutputTokens,
  });
}

/** Like resolveModel, but always returns an instance for direct one-shot calls. */
export function resolveModelInstance(
  cfg: AppConfig,
  tierName: string,
): BaseLlm {
  const resolved = resolveModel(cfg, tierName);
  return typeof resolved === 'string' ? LLMRegistry.newLlm(resolved) : resolved;
}
