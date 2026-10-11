import { describe, expect, it, vi } from 'vitest';
import { createPrepareRepoTool } from './prepare-repo.tool.js';
import { STATE } from '../constants/state-keys.constant.js';
import type { GitAdapterContract } from 'shared-types';

describe('prepareRepoTool', () => {
  it('throws error when gitAdapter dependency is missing', async () => {
    const tool = createPrepareRepoTool({});
    const mockCtx = { state: new Map() } as any;

    await expect(
      (tool as any).execute(
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

    const stateMap = new Map<string, any>();
    const mockCtx = {
      state: {
        set: (k: string, v: any) => stateMap.set(k, v),
        get: (k: string) => stateMap.get(k),
      },
    } as any;

    const result = await (tool as any).execute(
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
