import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { describe, expect, it, vi } from 'vitest';

import {
  createGetRepoGuidelinesTool,
  type GetRepoGuidelinesResult,
  parseSkillFrontmatter,
} from './get-repo-guidelines.tool.js';

describe('getRepoGuidelines tool', () => {
  it('parses skill frontmatter correctly', () => {
    const rawSkill = `---
name: nx-workspace
description: "Explore and understand Nx workspaces."
---

# Details
More content...`;

    const parsed = parseSkillFrontmatter(rawSkill);
    expect(parsed.name).toBe('nx-workspace');
    expect(parsed.description).toBe('Explore and understand Nx workspaces.');
  });

  it('fetches rules and discovers skills via gitAdapter', async () => {
    const getFileContent = vi.fn().mockImplementation((_o, _r, path) => {
      if (path === 'AGENTS.md') {
        return Promise.resolve({
          path: 'AGENTS.md',
          content: '# Agent Rules\nAlways prefix with pnpm nx.',
        });
      }
      if (path === '.agents/skills/nx/SKILL.md') {
        return Promise.resolve({
          path: '.agents/skills/nx/SKILL.md',
          content: `---\nname: nx\ndescription: Nx workspace skill\n---\nBody`,
        });
      }
      return Promise.reject(new Error('File not found'));
    });

    const searchCode = vi.fn().mockResolvedValue({
      totalCount: 1,
      items: [{ name: 'SKILL.md', path: '.agents/skills/nx/SKILL.md' }],
    });

    const mockGitAdapter = {
      getFileContent,
      searchCode,
    } as unknown as GitAdapterContract;

    const tool = createGetRepoGuidelinesTool({
      scope: {
        gitAdapter: mockGitAdapter,
        owner: 'test-owner',
        repo: 'test-repo',
      },
    });

    const stateMap = new Map<string, unknown>();
    const mockContext = {
      state: {
        set: vi.fn((k, v) => stateMap.set(k, v)),
        get: vi.fn((k) => stateMap.get(k)),
      },
    };

    const result = (await tool.execute(
      {},
      mockContext,
    )) as GetRepoGuidelinesResult;

    expect(result.rules).toContain(
      '# Agent Rules\nAlways prefix with pnpm nx.',
    );
    expect(result.ruleSources).toContain('AGENTS.md');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toEqual({
      name: 'nx',
      path: '.agents/skills/nx/SKILL.md',
      description: 'Nx workspace skill',
    });
    expect(mockContext.state.set).toHaveBeenCalledWith(
      'repoctx:agentDocs',
      expect.stringContaining('Always prefix with pnpm nx'),
    );
  });

  it('reads rules from the base branch, not the PR head', async () => {
    const getFileContent = vi.fn().mockRejectedValue(new Error('not found'));
    const tool = createGetRepoGuidelinesTool({
      scope: {
        gitAdapter: {
          getFileContent,
          searchCode: vi.fn().mockResolvedValue({ totalCount: 0, items: [] }),
        } as unknown as GitAdapterContract,
        owner: 'test-owner',
        repo: 'test-repo',
        headRef: 'feature/edits-claude-md',
        baseRef: 'main',
      },
    });

    await tool.execute({}, undefined);

    expect(getFileContent).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      'AGENTS.md',
      'main',
    );
  });
});
