import { describe, expect, it } from 'vitest';

import { REVIEW_SKILL } from './review.skill.js';

describe('REVIEW_SKILL', () => {
  it('embeds the review philosophy as prompt text (no filesystem loading)', () => {
    expect(REVIEW_SKILL.core).toContain('Verify before asserting');
    expect(REVIEW_SKILL.core).toContain('critical');
    expect(REVIEW_SKILL.core).toContain('major');
    expect(REVIEW_SKILL.core).toContain('minor');
  });

  it('embeds the security checklist', () => {
    expect(REVIEW_SKILL.security).toContain('Injection');
    expect(REVIEW_SKILL.security).toContain('SSRF');
    expect(REVIEW_SKILL.security).toContain('TOCTOU');
  });
});
