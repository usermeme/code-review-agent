import { describe, expect, it } from 'vitest';

import type { LoadedContextSource } from './context-sources.js';
import type { ExtractedRule } from './review-rule.schema.js';
import { validateRules } from './validate-rules.js';

const ROOT: LoadedContextSource = {
  path: 'AGENTS.md',
  kind: 'guideline',
  blobSha: 'root',
  content: ['# Rules', 'Never log tokens.', 'Use parameterized SQL.'].join(
    '\n',
  ),
};

const NESTED: LoadedContextSource = {
  path: 'apps/core/AGENTS.md',
  kind: 'guideline',
  blobSha: 'nested',
  content: 'Persist through repositories only.',
};

function extracted(overrides: Partial<ExtractedRule> = {}): ExtractedRule {
  return {
    id: 'no-token-logging',
    rule: 'Never log tokens.',
    appliesTo: [],
    severity: 'critical',
    source: { path: 'AGENTS.md', startLine: 2, endLine: 2 },
    ...overrides,
  };
}

describe('validateRules', () => {
  it('keeps a valid rule as the model wrote it', () => {
    expect(validateRules([extracted()], [ROOT])).toEqual([
      {
        id: 'no-token-logging',
        rule: 'Never log tokens.',
        appliesTo: [],
        severity: 'critical',
        source: { path: 'AGENTS.md', startLine: 2, endLine: 2 },
      },
    ]);
  });

  it('drops rules that cite a file that was not an input, or have no text', () => {
    const rules = validateRules(
      [
        extracted({ source: { path: 'INVENTED.md' } }),
        extracted({ rule: '   ' }),
      ],
      [ROOT],
    );

    expect(rules).toEqual([]);
  });

  it('matches the source path case-insensitively and keeps the real spelling', () => {
    const [rule] = validateRules(
      [extracted({ source: { path: './agents.md' } })],
      [ROOT],
    );

    expect(rule.source).toEqual({ path: 'AGENTS.md' });
  });

  it('clamps line numbers to the file and orders a reversed range', () => {
    const [rule] = validateRules(
      [extracted({ source: { path: 'AGENTS.md', startLine: 99, endLine: 2 } })],
      [ROOT],
    );

    expect(rule.source).toEqual({
      path: 'AGENTS.md',
      startLine: 2,
      endLine: 3,
    });
  });

  it('keeps a nested guideline rule inside its folder whatever the model said', () => {
    const rules = validateRules(
      [
        extracted({ source: { path: 'apps/core/AGENTS.md' } }),
        extracted({
          source: { path: 'apps/core/AGENTS.md' },
          appliesTo: ['apps/core/src/**', 'libs/**'],
        }),
        extracted({
          source: { path: 'apps/core/AGENTS.md' },
          appliesTo: ['**/*.ts'],
        }),
      ],
      [NESTED],
    );

    expect(rules.map((rule) => rule.appliesTo)).toEqual([
      ['apps/core/**'],
      ['apps/core/src/**'],
      ['apps/core/**'],
    ]);
  });

  it('normalizes globs on root rules', () => {
    const [rule] = validateRules(
      [extracted({ appliesTo: ['/src/**', ' ./db/** ', '', 'src/**'] })],
      [ROOT],
    );

    expect(rule.appliesTo).toEqual(['src/**', 'db/**']);
  });

  it('slugifies ids and makes them unique', () => {
    const rules = validateRules(
      [
        extracted({ id: 'No Token Logging!' }),
        extracted({ id: 'no-token-logging' }),
      ],
      [ROOT],
    );

    expect(rules.map((rule) => rule.id)).toEqual([
      'no-token-logging',
      'no-token-logging-2',
    ]);
  });

  it('never writes undefined fields (Firestore rejects them)', () => {
    const [rule] = validateRules(
      [extracted({ source: { path: 'AGENTS.md' } })],
      [ROOT],
    );

    expect(Object.keys(rule.source)).toEqual(['path']);
  });
});
