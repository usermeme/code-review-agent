import { describe, expect, it } from 'vitest';

import {
  classifyContextSource,
  hashContextSources,
  selectContextSources,
} from './context-sources.js';

describe('classifyContextSource', () => {
  it.each([
    ['AGENTS.md', 'guideline'],
    ['apps/core/claude.md', 'guideline'],
    ['.cursorrules', 'guideline'],
    ['.github/copilot-instructions.md', 'guideline'],
    ['.agents/skills/testing/SKILL.md', 'skill'],
  ])('classifies %s as %s', (path, kind) => {
    expect(classifyContextSource(path)).toBe(kind);
  });

  it.each([
    'README.md',
    'SKILL.md',
    'docs/.github/copilot-instructions.md',
    'node_modules/pkg/AGENTS.md',
    'vendor/lib/skills/x/SKILL.md',
  ])('ignores %s', (path) => {
    expect(classifyContextSource(path)).toBeNull();
  });
});

describe('selectContextSources', () => {
  it('keeps only context sources, sorted by path', () => {
    const sources = selectContextSources([
      { path: 'src/index.ts', blobSha: 'a' },
      { path: 'skills/b/SKILL.md', blobSha: 'b' },
      { path: 'AGENTS.md', blobSha: 'c' },
    ]);

    expect(sources).toEqual([
      { path: 'AGENTS.md', kind: 'guideline', blobSha: 'c' },
      { path: 'skills/b/SKILL.md', kind: 'skill', blobSha: 'b' },
    ]);
  });
});

describe('hashContextSources', () => {
  const agents = {
    path: 'AGENTS.md',
    kind: 'guideline',
    blobSha: 'a1',
  } as const;
  const skill = { path: 's/x/SKILL.md', kind: 'skill', blobSha: 'b2' } as const;

  it('does not depend on input order', () => {
    expect(hashContextSources([agents, skill])).toBe(
      hashContextSources([skill, agents]),
    );
  });

  it('changes when a file changes or moves', () => {
    const base = hashContextSources([agents, skill]);

    expect(hashContextSources([{ ...agents, blobSha: 'a9' }, skill])).not.toBe(
      base,
    );
    expect(
      hashContextSources([{ ...agents, path: 'apps/AGENTS.md' }, skill]),
    ).not.toBe(base);
  });
});
