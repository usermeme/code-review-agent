import { ThinkingLevel } from '@google/genai';

/** Budget and reasoning effort the reviewer agent gets at each depth. */
export interface TierProfile {
  thinkingLevel: ThinkingLevel;
  maxLlmCalls: number;
  maxInlineDiffChars: number;
}

export const TIER_PROFILES = {
  /** Small, contained changes: low effort, small budget, compact inline diff. */
  light: {
    thinkingLevel: ThinkingLevel.LOW,
    maxLlmCalls: 4,
    maxInlineDiffChars: 30_000,
  },
  /** Risky or wide changes: high effort, full budget, large inline diff. */
  deep: {
    thinkingLevel: ThinkingLevel.HIGH,
    maxLlmCalls: 10,
    maxInlineDiffChars: 80_000,
  },
} as const satisfies Record<'light' | 'deep', TierProfile>;
