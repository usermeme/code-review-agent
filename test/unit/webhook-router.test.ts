import { describe, expect, it } from 'vitest';
import { repoAllowed } from '../../src/server/webhook-router.js';

describe('repoAllowed', () => {
  it('allows everything when the list is empty', () => {
    expect(repoAllowed('a/b', [])).toBe(true);
  });

  it('matches org wildcards without crossing the slash', () => {
    expect(repoAllowed('goflink/api', ['goflink/*'])).toBe(true);
    expect(repoAllowed('goflink/nested/x', ['goflink/*'])).toBe(false);
    expect(repoAllowed('other/api', ['goflink/*'])).toBe(false);
  });

  it('matches exact names', () => {
    expect(repoAllowed('a/b', ['a/b', 'c/*'])).toBe(true);
    expect(repoAllowed('a/bc', ['a/b'])).toBe(false);
  });
});
