import { RepoWorkspace } from '@code-review-agent/agent-tools';
import type { ReviewRule } from '@code-review-agent/shared-types';
import { describe, expect, it } from 'vitest';

import {
  formatRepositoryInstruction,
  formatScopedRulesSection,
} from './rule-prompt.js';
import { formatRuleList, selectRules } from './select-rules.js';

function rule(
  id: string,
  appliesTo: string[],
  severity: ReviewRule['severity'] = 'major',
): ReviewRule {
  return {
    id,
    rule: `Rule ${id}.`,
    appliesTo,
    severity,
    source: { path: 'AGENTS.md', startLine: 3, endLine: 5 },
  };
}

describe('selectRules', () => {
  it('splits repo-wide rules from the scoped ones this PR touches', () => {
    const selected = selectRules(
      [
        rule('global', []),
        rule('sql', ['**/*.sql']),
        rule('core', ['apps/core/**']),
      ],
      ['apps/core/src/main.ts'],
    );

    expect(selected.global.map((r) => r.id)).toEqual(['global']);
    expect(selected.scoped.map((r) => r.id)).toEqual(['core']);
  });
});

describe('formatRuleList', () => {
  it('lists rules most severe first with their scope and source', () => {
    const list = formatRuleList([
      rule('minor', [], 'minor'),
      rule('critical', ['db/**'], 'critical'),
    ]);

    expect(list.split('\n')).toEqual([
      '- [CRITICAL] Rule critical. Applies to: `db/**`. (source: `AGENTS.md#L3-L5`)',
      '- [MINOR] Rule minor. (source: `AGENTS.md#L3-L5`)',
    ]);
  });

  it('stops at the character budget', () => {
    const list = formatRuleList([rule('a', []), rule('b', [])], 60);

    expect(list.split('\n')).toHaveLength(1);
  });
});

describe('rule prompt sections', () => {
  const workspace = new RepoWorkspace({
    files: new Map([['AGENTS.md', ['Raw guideline text.']]]),
    rawDiff: '',
    changedFiles: [],
  });

  it('uses the rules instead of the raw guidelines when a context resolved', () => {
    const selected = { global: [rule('global', [])], scoped: [] };

    const instruction = formatRepositoryInstruction(workspace, selected);

    expect(instruction).toContain('## Repository Rules');
    expect(instruction).toContain('Rule global.');
    expect(instruction).not.toContain('Raw guideline text.');
  });

  it('adds no repository section when the context has no repo-wide rules', () => {
    expect(
      formatRepositoryInstruction(workspace, { global: [], scoped: [] }),
    ).toBe('');
  });

  it('falls back to the raw guidelines without a context', () => {
    expect(formatRepositoryInstruction(workspace, undefined)).toContain(
      'Raw guideline text.',
    );
  });

  it('lists scoped rules in their own per-PR section', () => {
    expect(
      formatScopedRulesSection({
        global: [],
        scoped: [rule('core', ['x/**'])],
      }),
    ).toContain('### Rules for the Changed Paths');
    expect(formatScopedRulesSection(undefined)).toBe('');
  });
});
