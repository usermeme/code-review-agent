import type { TokenUsage } from '@code-review-agent/shared-types';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';

export function emptyTokenUsage(): TokenUsage {
  return {
    calls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
  };
}

function count(value: number | undefined): number {
  return value ?? 0;
}

/** Adds one model response's usage metadata to `usage` (mutates and returns it). */
export function addUsageMetadata(
  usage: TokenUsage,
  metadata: GenerateContentResponseUsageMetadata | undefined,
): TokenUsage {
  if (!metadata) return usage;
  usage.calls += 1;
  usage.promptTokens += count(metadata.promptTokenCount);
  usage.cachedTokens += count(metadata.cachedContentTokenCount);
  usage.outputTokens += count(metadata.candidatesTokenCount);
  usage.thoughtsTokens += count(metadata.thoughtsTokenCount);
  return usage;
}

export function sumTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thoughtsTokens: a.thoughtsTokens + b.thoughtsTokens,
  };
}
