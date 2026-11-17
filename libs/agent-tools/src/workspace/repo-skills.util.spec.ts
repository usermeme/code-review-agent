import { describe, expect, it } from 'vitest';

import { extractRepoSkillsIndex, findRepoSkills } from './repo-skills.util.js';

const SKILL_BODY = ['---', 'name: x', 'description: Does x.', '---', '# Body'];

describe('findRepoSkills', () => {
  it('finds SKILL.md files in any directory, named after their folder', () => {
    const files = new Map<string, string[]>([
      ['src/index.ts', ['export const a = 1;']],
      ['.claude/skills/testing/SKILL.md', SKILL_BODY],
      ['tools/skills/deploy/skill.md', SKILL_BODY],
      ['docs/SKILL.md.bak', SKILL_BODY],
    ]);

    expect(findRepoSkills(files)).toEqual([
      { name: 'testing', path: '.claude/skills/testing/SKILL.md' },
      { name: 'deploy', path: 'tools/skills/deploy/skill.md' },
    ]);
  });

  it('lists a skill mirrored for several agents once, under the first path', () => {
    const files = new Map<string, string[]>([
      ['.opencode/skills/nx-generate/SKILL.md', SKILL_BODY],
      ['.agents/skills/nx-generate/SKILL.md', SKILL_BODY],
    ]);

    expect(findRepoSkills(files)).toEqual([
      { name: 'nx-generate', path: '.agents/skills/nx-generate/SKILL.md' },
    ]);
  });

  it('ignores a SKILL.md at the repository root', () => {
    const files = new Map<string, string[]>([['SKILL.md', SKILL_BODY]]);

    expect(findRepoSkills(files)).toEqual([]);
  });
});

describe('extractRepoSkillsIndex', () => {
  it('returns an empty string when the repository has no skills', () => {
    const files = new Map<string, string[]>([['AGENTS.md', ['# Rules']]]);

    expect(extractRepoSkillsIndex(files)).toBe('');
  });

  it('lists names and paths with lookup instructions, never skill contents', () => {
    const files = new Map<string, string[]>([
      ['.agents/skills/testing/SKILL.md', SKILL_BODY],
    ]);

    const index = extractRepoSkillsIndex(files);

    expect(index).toContain('- `testing`: `.agents/skills/testing/SKILL.md`');
    expect(index).toContain('pattern: "^description:"');
    expect(index).toContain('read_file({ path: "<path>" })');
    expect(index).not.toContain('Does x.');
    expect(index).not.toContain('# Body');
  });

  it('caps the list and points to find_files for the rest', () => {
    const files = new Map<string, string[]>([
      ['skills/a/SKILL.md', SKILL_BODY],
      ['skills/b/SKILL.md', SKILL_BODY],
      ['skills/c/SKILL.md', SKILL_BODY],
    ]);

    const index = extractRepoSkillsIndex(files, 2);

    expect(index).toContain('- `a`: `skills/a/SKILL.md`');
    expect(index).toContain('- `b`: `skills/b/SKILL.md`');
    expect(index).not.toContain('skills/c/SKILL.md');
    expect(index).toContain('…and 1 more');
  });
});
