import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { STATE } from '../constants/state-keys.constant.js';
import { createPrepareRepoTool } from './prepare-repo.tool.js';

describe('prepareRepoTool', () => {
  it('throws error when gitAdapter dependency is missing', async () => {
    const tool = createPrepareRepoTool({});
    const mockCtx = {
      state: new Map(),
    } as unknown;

    await expect(
      tool.execute(
        {
          provider: 'github',
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 1,
        },
        mockCtx,
      ),
    ).rejects.toThrow(
      'Git adapter contract is required to prepare repository context.',
    );
  });

  it('prepares incremental repository using gitAdapter.getPRFiles', async () => {
    const mockGitAdapter: Partial<GitAdapterContract> = {
      getPRFiles: vi.fn().mockResolvedValue([
        {
          filename: 'src/main.ts',
          status: 'modified',
          content: 'console.log("hello world");',
        },
        {
          filename: 'deleted.ts',
          status: 'removed',
        },
      ]),
    };

    const tool = createPrepareRepoTool({
      gitAdapter: mockGitAdapter as GitAdapterContract,
    });

    const stateMap = new Map<string, unknown>();
    const mockCtx = {
      state: {
        set: (k: string, v: unknown) => stateMap.set(k, v),
        get: (k: string) => stateMap.get(k),
      },
    } as unknown;

    const result = await tool.execute(
      {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        isIncrementalUpdate: true,
      },
      mockCtx,
    );

    expect(mockGitAdapter.getPRFiles).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
    );
    expect(result).toContain('Incremental update prepared successfully');
    expect(stateMap.has(STATE.chunks)).toBe(true);
    expect(stateMap.get(STATE.chunks)).toHaveLength(1);
  });
});
