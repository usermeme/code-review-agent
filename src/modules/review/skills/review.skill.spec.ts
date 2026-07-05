import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadReviewSkill, stripFrontmatter } from './review.skill.js';

let skillDir: string;

beforeAll(async () => {
  skillDir = await mkdtemp(join(tmpdir(), 'review-skill-'));
  await mkdir(join(skillDir, 'references'), { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: code-review\ndescription: test\n---\n# Code Review\n\nVerify before asserting.\n',
  );
  await writeFile(join(skillDir, 'references', 'security.md'), '# Security\n\nParameterize SQL.\n');
});

afterAll(async () => {
  await rm(skillDir, { recursive: true, force: true });
});

describe('stripFrontmatter', () => {
  it('removes the YAML block and trims', () => {
    expect(stripFrontmatter('---\nname: x\n---\nBody here\n')).toBe('Body here');
  });

  it('leaves frontmatter-less markdown untouched', () => {
    expect(stripFrontmatter('# Title\nBody')).toBe('# Title\nBody');
  });
});

describe('loadReviewSkill', () => {
  it('loads SKILL.md and security reference from the configured dir, stripping frontmatter', () => {
    const skill = loadReviewSkill(skillDir);
    expect(skill.core).toContain('Verify before asserting.');
    expect(skill.core).not.toContain('description: test');
    expect(skill.security).toContain('Parameterize SQL.');
  });

  it('falls back to the embedded snapshot when the dir is empty or missing', () => {
    for (const skill of [loadReviewSkill(''), loadReviewSkill('/nonexistent/path')]) {
      expect(skill.core).toContain('Verify before asserting');
      expect(skill.security).toContain('Injection');
    }
  });
});
