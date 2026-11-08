import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitAdapterClient } from './git-adapter.client.js';

describe('GitAdapterClient', () => {
  const baseUrl = 'http://adapter:8080';
  let client: GitAdapterClient;

  beforeEach(() => {
    client = new GitAdapterClient(baseUrl);
    vi.restoreAllMocks();
  });

  it('fetches PR diff successfully', async () => {
    const mockResponse = {
      diff: 'diff --git a/test b/test',
      changedFiles: ['test.ts'],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockResponse),
    });

    const result = await client.getPRDiff('owner', 'repo', 10);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://adapter:8080/api/v1/repos/owner/repo/pulls/10/diff',
    );
    expect(result).toEqual(mockResponse);
  });

  it('throws error when PR diff fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(client.getPRDiff('owner', 'repo', 10)).rejects.toThrow(
      'Failed to fetch PR diff from git adapter: HTTP 404 Not Found',
    );
  });

  it('fetches repo tarball successfully', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await client.getRepoTarball(
      'owner',
      'repo',
      'feature-branch',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://adapter:8080/api/v1/repos/owner/repo/tarball?ref=feature-branch',
    );
    expect(result).toBe(mockResponse);
  });

  it('throws NonRetryableTaskError when adapter responds with nonRetryable: true', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: vi.fn().mockResolvedValue({
        error: 'GitHub App is not installed on owner/repo',
        nonRetryable: true,
      }),
    });

    const promise = client.getPRDiff('owner', 'repo', 10);
    await expect(promise).rejects.toBeInstanceOf(NonRetryableTaskError);
    await expect(promise).rejects.toThrow(
      'Failed to fetch PR diff from git adapter: GitHub App is not installed on owner/repo',
    );
  });
});
