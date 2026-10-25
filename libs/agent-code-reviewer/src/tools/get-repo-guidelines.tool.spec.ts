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
      gitAdapter: mockGitAdapter,
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
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

  it('handles missing gitAdapter gracefully', async () => {
    const tool = createGetRepoGuidelinesTool({
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
    });

    const result = (await tool.execute(
      {},
      undefined,
    )) as GetRepoGuidelinesResult;
    expect(result.skills).toHaveLength(0);
    expect(result.message).toContain('Git adapter is not configured');
  });

  it('caps rule text and fetches each mirrored skill directory once', async () => {
    const getFileContent = vi.fn().mockImplementation((_o, _r, path) => {
      if (path === 'AGENTS.md') {
        return Promise.resolve({ path, content: 'x'.repeat(50_000) });
      }
      if (path.endsWith('SKILL.md')) {
        return Promise.resolve({
          path,
          content: `---\nname: nx\ndescription: Nx skill\n---\nBody`,
        });
      }
      return Promise.reject(new Error('File not found'));
    });
    const searchCode = vi.fn().mockResolvedValue({
      totalCount: 3,
      items: [
        { name: 'SKILL.md', path: '.agents/skills/nx/SKILL.md' },
        { name: 'SKILL.md', path: '.opencode/skills/nx/SKILL.md' },
        { name: 'SKILL.md', path: 'node_modules/pkg/skills/x/SKILL.md' },
      ],
    });
    const tool = createGetRepoGuidelinesTool({
      gitAdapter: {
        getFileContent,
        searchCode,
      } as unknown as GitAdapterContract,
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
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

    expect(result.skills.map((s) => s.path)).toEqual([
      '.agents/skills/nx/SKILL.md',
    ]);
    const stagedRules = stateMap.get('repoctx:agentDocs') as string;
    expect(stagedRules.length).toBeLessThan(21_000);
    expect(stagedRules).toContain('truncated');
  });
});
