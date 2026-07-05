import { describe, expect, it } from 'vitest';
import { bearerMatches } from './admin.routes.js';

describe('bearerMatches', () => {
  it('accepts the exact Bearer token', () => {
    expect(bearerMatches('Bearer sekret', 'sekret')).toBe(true);
  });

  it('rejects wrong, missing, malformed, and length-mismatched headers', () => {
    expect(bearerMatches('Bearer nope', 'sekret')).toBe(false);
    expect(bearerMatches(undefined, 'sekret')).toBe(false);
    expect(bearerMatches('sekret', 'sekret')).toBe(false); // missing "Bearer " prefix
    expect(bearerMatches('Bearer sekret-extra', 'sekret')).toBe(false);
  });
});
