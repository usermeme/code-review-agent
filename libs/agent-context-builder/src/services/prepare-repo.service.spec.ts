import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { STATE } from '../constants/state-keys.constant.js';
import { PipelineState } from './pipeline-state.js';
import { prepareRepository } from './prepare-repo.service.js';

describe('prepareRepository', () => {
  it('throws error when gitAdapter dependency is missing', async () => {
    await expect(
      prepareRepository(
        {},
        {
          provider: 'github',
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 1,
        },
        new PipelineState(),
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

    const state = new PipelineState();

    const result = await prepareRepository(
      { gitAdapter: mockGitAdapter as GitAdapterContract },
      {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        isIncrementalUpdate: true,
      },
      state,
    );

    expect(mockGitAdapter.getPRFiles).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
    );
    expect(result).toContain('Incremental update prepared successfully');
    expect(state.get<unknown[]>(STATE.chunks)).toHaveLength(1);
  });

  it('filters lockfiles, binaries and generated content in incremental mode', async () => {
    const mockGitAdapter: Partial<GitAdapterContract> = {
      getPRFiles: vi.fn().mockResolvedValue([
        {
          filename: 'pnpm-lock.yaml',
          status: 'modified',
          content: 'lockfileVersion: 9\n'.repeat(100),
        },
        {
          filename: 'dist/apps/core/server.js',
          status: 'modified',
          content: 'bundled code',
        },
        {
          filename: 'assets/logo.png',
          status: 'added',
          content: 'binary-ish',
        },
        {
          filename: 'generated.txt',
          status: 'added',
          content: `header\n${'x'.repeat(6000)}\n`,
        },
        {
          filename: 'src/real-code.ts',
          status: 'modified',
          content: 'export const a = 1;',
        },
      ]),
    };

    const state = new PipelineState();

    const result = await prepareRepository(
      { gitAdapter: mockGitAdapter as GitAdapterContract },
      {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        isIncrementalUpdate: true,
      },
      state,
    );

    const chunks = state.get<Array<{ files: Array<{ path: string }> }>>(
      STATE.chunks,
    );
    const paths = chunks?.flatMap((c) => c.files.map((f) => f.path)) ?? [];
    expect(paths).toEqual(['src/real-code.ts']);
    expect(result).toContain('skipped 4 generated/ignored file(s)');
  });
});
