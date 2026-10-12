import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { createSearchRepositoryCodeTool } from './search-repository-code.tool.js';

interface SearchResult {
  totalCount: number;
  items: Array<{ name: string; path: string }>;
  message?: string;
}

describe('searchRepositoryCode tool', () => {
  it('returns items from gitAdapter.searchCode', async () => {
    const searchCode = vi.fn().mockResolvedValue({
      totalCount: 2,
      items: [
        { name: 'user.service.ts', path: 'src/user.service.ts' },
        { name: 'auth.service.ts', path: 'src/auth.service.ts' },
      ],
    });
    const mockGitAdapter = {
      searchCode,
    } as unknown as GitAdapterContract;

    const tool = createSearchRepositoryCodeTool({
      gitAdapter: mockGitAdapter,
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
    });

    const result = (await tool.execute(
      { query: 'validateUser' },
      undefined,
    )) as SearchResult;

    expect(searchCode).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      'validateUser',
    );
    expect(result.totalCount).toBe(2);
    expect(result.items).toHaveLength(2);
  });

  it('handles missing gitAdapter gracefully', async () => {
    const tool = createSearchRepositoryCodeTool({
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
    });

    const result = (await tool.execute(
      { query: 'test' },
      undefined,
    )) as SearchResult;
    expect(result.totalCount).toBe(0);
    expect(result.message).toContain('Git adapter is not configured');
  });

  it('handles searchCode error gracefully', async () => {
    const searchCode = vi.fn().mockRejectedValue(new Error('API rate limit'));
    const mockGitAdapter = {
      searchCode,
    } as unknown as GitAdapterContract;

    const tool = createSearchRepositoryCodeTool({
      gitAdapter: mockGitAdapter,
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
    });

    const result = (await tool.execute(
      { query: 'test' },
      undefined,
    )) as SearchResult;
    expect(result.totalCount).toBe(0);
    expect(result.message).toContain('Code search failed');
  });
});
