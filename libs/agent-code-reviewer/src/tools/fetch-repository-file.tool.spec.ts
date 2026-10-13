import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { createFetchRepositoryFileTool } from './fetch-repository-file.tool.js';

interface FetchResult {
  path?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  error?: string;
}

describe('fetchRepositoryFile tool', () => {
  it('fetches file content with line numbers and caches result', async () => {
    const getFileContent = vi.fn().mockResolvedValue({
      path: 'src/app.ts',
      content: 'const a = 1;\nconst b = 2;\nconst c = 3;',
    });
    const mockGitAdapter = {
      getFileContent,
    } as unknown as GitAdapterContract;

    const cache = new Map<string, string>();
    const tool = createFetchRepositoryFileTool({
      scope: {
        gitAdapter: mockGitAdapter,
        owner: 'test-owner',
        repo: 'test-repo',
      },
      cache,
    });

    const result = (await tool.execute(
      { path: 'src/app.ts', startLine: 1, endLine: 2 },
      undefined,
    )) as FetchResult;

    expect(getFileContent).toHaveBeenCalledTimes(1);
    expect(result.path).toBe('src/app.ts');
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(2);
    expect(result.content).toContain('1: const a = 1;\n2: const b = 2');

    // Second call should hit cache
    await tool.execute(
      { path: 'src/app.ts', startLine: 2, endLine: 3 },
      undefined,
    );
    expect(getFileContent).toHaveBeenCalledTimes(1);
  });

  it('blocks lockfiles and binary files', async () => {
    const tool = createFetchRepositoryFileTool({
      scope: {
        gitAdapter: {} as GitAdapterContract,
        owner: 'test-owner',
        repo: 'test-repo',
      },
    });

    const result = (await tool.execute(
      { path: 'package-lock.json' },
      undefined,
    )) as FetchResult;

    expect(result.error).toContain('matches blocked extensions');
  });

  it('handles getFileContent failure gracefully', async () => {
    const getFileContent = vi
      .fn()
      .mockRejectedValue(new Error('File not found'));
    const mockGitAdapter = {
      getFileContent,
    } as unknown as GitAdapterContract;

    const tool = createFetchRepositoryFileTool({
      scope: {
        gitAdapter: mockGitAdapter,
        owner: 'test-owner',
        repo: 'test-repo',
      },
    });

    const result = (await tool.execute(
      { path: 'missing.ts' },
      undefined,
    )) as FetchResult;

    expect(result.error).toContain('Failed to fetch file');
  });
});
