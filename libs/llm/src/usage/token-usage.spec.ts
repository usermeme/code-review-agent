import { describe, expect, it } from 'vitest';

import {
  addUsageMetadata,
  emptyTokenUsage,
  sumTokenUsage,
} from './token-usage.js';

describe('token usage', () => {
  it('counts a call and its token fields, treating missing fields as zero', () => {
    const usage = addUsageMetadata(emptyTokenUsage(), {
      promptTokenCount: 1200,
      cachedContentTokenCount: 800,
      candidatesTokenCount: 50,
    });

    expect(usage).toEqual({
      calls: 1,
      promptTokens: 1200,
      cachedTokens: 800,
      outputTokens: 50,
      thoughtsTokens: 0,
    });
  });

  it('ignores responses without usage metadata', () => {
    expect(addUsageMetadata(emptyTokenUsage(), undefined).calls).toBe(0);
  });

  it('sums two usage records field by field', () => {
    const a = addUsageMetadata(emptyTokenUsage(), {
      promptTokenCount: 10,
      thoughtsTokenCount: 3,
    });
    const b = addUsageMetadata(emptyTokenUsage(), {
      promptTokenCount: 5,
      candidatesTokenCount: 2,
    });

    expect(sumTokenUsage(a, b)).toEqual({
      calls: 2,
      promptTokens: 15,
      cachedTokens: 0,
      outputTokens: 2,
      thoughtsTokens: 3,
    });
  });
});
