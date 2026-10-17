import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LIMITS } from '../constants/limits.constant.js';
import { STATE } from '../constants/state-keys.constant.js';
import {
  createLoadRepoSkillTool,
  type LoadedRepoSkill,
  renderLoadedSkills,
  stripSkillFrontmatter,
} from './load-repo-skill.tool.js';

const CATALOGUE = [
  {
    name: 'nx',
    path: '.agents/skills/nx/SKILL.md',
    description: 'Nx workspace conventions.',
  },
  {
    name: 'testing',
    path: '.agents/skills/testing/SKILL.md',
    description: 'Testing discipline.',
  },
];

function makeCtx(initial?: Map<string, unknown>) {
  const stateMap =
    initial ??
    new Map<string, unknown>([
      [
        STATE.prMeta,
        { owner: 'real', repo: 'pr-repo', number: 1, branch: 'feature/x' },
      ],
      [STATE.repoSkills, CATALOGUE],
    ]);
  return {
    stateMap,
    ctx: {
      state: {
        get: (key: string) => stateMap.get(key),
        set: (key: string, val: unknown) => stateMap.set(key, val),
      },
    } as unknown,
  };
}

const SKILL_CONTENT =
  '---\nname: nx\ndescription: Nx workspace conventions.\n---\n# Nx\nUse nx targets.\n';

describe('loadRepoSkill tool', () => {
  const getFileContent = vi.fn();

  beforeEach(() => {
    getFileContent.mockReset();
  });

  const makeTool = () =>
    createLoadRepoSkillTool({
      gitAdapter: { getFileContent } as unknown as GitAdapterContract,
    });

  it('stages the body in state, strips frontmatter, and never returns it to the caller', async () => {
    getFileContent.mockResolvedValue({ content: SKILL_CONTENT });
    const { stateMap, ctx } = makeCtx();

    const result = await makeTool().execute({ skills: ['nx'] }, ctx);

    expect(getFileContent).toHaveBeenCalledWith(
      'real',
      'pr-repo',
      '.agents/skills/nx/SKILL.md',
      'feature/x',
    );
    expect(result.loaded).toEqual([
      {
        name: 'nx',
        path: '.agents/skills/nx/SKILL.md',
        chars: expect.any(Number),
      },
    ]);
    // The acknowledgement must not leak the body to the orchestrator.
    expect(JSON.stringify(result)).not.toContain('Use nx targets');

    const bodies = stateMap.get(STATE.repoSkillBodies) as Record<
      string,
      LoadedRepoSkill
    >;
    expect(bodies['.agents/skills/nx/SKILL.md']).toEqual({
      name: 'nx',
      path: '.agents/skills/nx/SKILL.md',
      content: '# Nx\nUse nx targets.',
      truncated: false,
    });
  });

  it('only accepts skills present in the catalogue (allowlist)', async () => {
    const { stateMap, ctx } = makeCtx();

    const result = await makeTool().execute(
      { skills: ['../../etc/passwd', 'nonexistent'] },
      ctx,
    );

    expect(result.loaded).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain('catalogue');
    expect(getFileContent).not.toHaveBeenCalled();
    expect(stateMap.has(STATE.repoSkillBodies)).toBe(false);
  });

  it('asks for getRepoGuidelines first when no catalogue is in state', async () => {
    const { ctx } = makeCtx(
      new Map([[STATE.prMeta, { owner: 'real', repo: 'pr-repo', number: 1 }]]),
    );

    const result = await makeTool().execute({ skills: ['nx'] }, ctx);

    expect(result.loaded).toHaveLength(0);
    expect(result.skipped[0].reason).toContain('getRepoGuidelines');
  });

  it('skips already-loaded skills and accumulates across calls', async () => {
    getFileContent.mockResolvedValue({ content: SKILL_CONTENT });
    const { stateMap, ctx } = makeCtx();
    const tool = makeTool();

    await tool.execute({ skills: ['nx'] }, ctx);
    const second = await tool.execute({ skills: ['nx', 'testing'] }, ctx);

    expect(second.skipped).toEqual([
      { requested: 'nx', reason: 'already loaded' },
    ]);
    expect(second.loaded.map((l) => l.name)).toEqual(['testing']);
    const bodies = stateMap.get(STATE.repoSkillBodies) as Record<
      string,
      LoadedRepoSkill
    >;
    expect(Object.keys(bodies)).toHaveLength(2);
  });

  it('truncates oversized bodies and marks them truncated', async () => {
    getFileContent.mockResolvedValue({
      content: `---\nname: testing\n---\n${'x'.repeat(LIMITS.maxSkillBodyChars + 500)}`,
    });
    const { stateMap, ctx } = makeCtx();

    const result = await makeTool().execute({ skills: ['testing'] }, ctx);

    expect(result.loaded[0].chars).toBe(LIMITS.maxSkillBodyChars);
    const bodies = stateMap.get(STATE.repoSkillBodies) as Record<
      string,
      LoadedRepoSkill
    >;
    expect(bodies['.agents/skills/testing/SKILL.md'].truncated).toBe(true);
  });

  it('skips a skill whose fetch fails without failing the whole call', async () => {
    getFileContent.mockRejectedValue(new Error('404'));
    const { stateMap, ctx } = makeCtx();

    const result = await makeTool().execute({ skills: ['nx'] }, ctx);

    expect(result.loaded).toHaveLength(0);
    expect(result.skipped[0].reason).toContain('fetch failed');
    expect(stateMap.has(STATE.repoSkillBodies)).toBe(false);
  });
});

describe('renderLoadedSkills', () => {
  it('returns an empty string when nothing is staged', () => {
    expect(renderLoadedSkills(undefined)).toBe('');
    expect(renderLoadedSkills({})).toBe('');
  });

  it('wraps bodies in UNTRUSTED tags with the non-instruction warning', () => {
    const rendered = renderLoadedSkills({
      '.agents/skills/nx/SKILL.md': {
        name: 'nx',
        path: '.agents/skills/nx/SKILL.md',
        content: 'Use nx targets.',
        truncated: false,
      },
    });

    expect(rendered).toContain('<UNTRUSTED_REPO_SKILL name="nx"');
    expect(rendered).toContain('Use nx targets.');
    expect(rendered).toContain('</UNTRUSTED_REPO_SKILL>');
    expect(rendered).toContain('never as commands');
  });
});

describe('stripSkillFrontmatter', () => {
  it('removes the YAML block and trims', () => {
    expect(stripSkillFrontmatter(SKILL_CONTENT)).toBe('# Nx\nUse nx targets.');
  });

  it('leaves frontmatter-less content untouched', () => {
    expect(stripSkillFrontmatter('# Body\n')).toBe('# Body');
  });
});
