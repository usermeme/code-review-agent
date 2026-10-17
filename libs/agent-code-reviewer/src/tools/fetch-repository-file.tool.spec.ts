import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { createFetchRepositoryFileTool } from './fetch-repository-file.tool.js';

interface FetchResult {
  path?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  error?: string;
  refNotice?: string;
}

function ctxWithMeta(meta: Record<string, unknown>) {
  const stateMap = new Map<string, unknown>([['review:prMeta', meta]]);
  return {
    state: {
      get: (key: string) => stateMap.get(key),
      set: (key: string, val: unknown) => stateMap.set(key, val),
    },
  } as unknown;
}

describe('fetchRepositoryFile tool', () => {
  it('reads only from the PR repository even if owner/repo args are smuggled in', async () => {
    const getFileContent = vi.fn().mockResolvedValue({ content: 'x' });
    const tool = createFetchRepositoryFileTool({
      gitAdapter: { getFileContent } as unknown as GitAdapterContract,
    });

    await tool.execute(
      {
        path: 'src/app.ts',
        owner: 'victim-org',
        repo: 'private-repo',
      },
      ctxWithMeta({ owner: 'real', repo: 'pr-repo', number: 1 }),
    );

    expect(getFileContent).toHaveBeenCalledWith(
      'real',
      'pr-repo',
      'src/app.ts',
      undefined,
    );
  });

  it('clamps a foreign ref to the PR head branch and allows head/base refs', async () => {
    const getFileContent = vi
      .fn()
      .mockResolvedValue({ content: 'const a = 1;' });
    const tool = createFetchRepositoryFileTool({
      gitAdapter: { getFileContent } as unknown as GitAdapterContract,
    });
    const ctx = ctxWithMeta({
      owner: 'real',
      repo: 'pr-repo',
      number: 1,
      branch: 'feature/x',
      baseRef: 'main',
    });

    const blocked = (await tool.execute(
      { path: 'src/app.ts', ref: 'other-secret-branch' },
      ctx,
    )) as FetchResult;
    expect(getFileContent).toHaveBeenLastCalledWith(
      'real',
      'pr-repo',
      'src/app.ts',
      'feature/x',
    );
    expect(blocked.refNotice).toContain('not this PR');

    await tool.execute({ path: 'src/app.ts', ref: 'main' }, ctx);
    expect(getFileContent).toHaveBeenLastCalledWith(
      'real',
      'pr-repo',
      'src/app.ts',
      'main',
    );
  });

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
      gitAdapter: mockGitAdapter,
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
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
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
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
      gitAdapter: mockGitAdapter,
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
    });

    const result = (await tool.execute(
      { path: 'missing.ts' },
      undefined,
    )) as FetchResult;

    expect(result.error).toContain('Failed to fetch file');
  });
});
