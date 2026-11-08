import { describe, expect, it } from 'vitest';

import { extractRepoGuidelines } from './repo-guidelines.util.js';

describe('extractRepoGuidelines', () => {
  it('extracts AGENTS.md and CLAUDE.md in priority order', () => {
    const files = new Map<string, string[]>([
      ['src/index.ts', ['export const a = 1;']],
      ['AGENTS.md', ['# Repo Rules', '- Use strict types']],
      ['.github/copilot-instructions.md', ['Prefer small functions']],
    ]);

    const guidelines = extractRepoGuidelines(files);
    expect(guidelines).toBe(
      [
        '### AGENTS.md',
        '# Repo Rules\n- Use strict types',
        '',
        '### .github/copilot-instructions.md',
        'Prefer small functions',
      ].join('\n'),
    );
  });

  it('returns empty string when no guideline files exist', () => {
    const files = new Map<string, string[]>([
      ['src/index.ts', ['export const a = 1;']],
    ]);

    expect(extractRepoGuidelines(files)).toBe('');
  });

  it('truncates combined guidelines to maxChars', () => {
    const files = new Map<string, string[]>([
      ['AGENTS.md', ['12345678901234567890']],
    ]);

    const truncated = extractRepoGuidelines(files, 15);
    expect(truncated).toHaveLength(15);
  });
});
