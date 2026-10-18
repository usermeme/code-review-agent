import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubService, GithubServiceDependencies } from './github.service.js';
import {
  GithubAppNotInstalledError,
  GithubAuthProvider,
} from './github-auth.service.js';

describe('GithubService (Adapter)', () => {
  let service: GithubService;
  let mockAuthService: {
    getOctokit: ReturnType<typeof vi.fn>;
  };
  let mockOctokit: {
    rest: {
      pulls: {
        get: ReturnType<typeof vi.fn>;
        listFiles: ReturnType<typeof vi.fn>;
        createReview: ReturnType<typeof vi.fn>;
        createReviewComment: ReturnType<typeof vi.fn>;
      };
      search: {
        code: ReturnType<typeof vi.fn>;
      };
      repos: {
        getContent: ReturnType<typeof vi.fn>;
        downloadTarballArchive: ReturnType<typeof vi.fn>;
      };
      issues: {
        createComment: ReturnType<typeof vi.fn>;
      };
    };
  };

  beforeEach(() => {
    mockOctokit = {
      rest: {
        pulls: {
          get: vi.fn(),
          listFiles: vi.fn(),
          createReview: vi.fn(),
          createReviewComment: vi.fn(),
        },
        search: {
          code: vi.fn(),
        },
        repos: {
          getContent: vi.fn(),
          downloadTarballArchive: vi.fn(),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };

    mockAuthService = {
      getOctokit: vi.fn().mockResolvedValue(mockOctokit),
    };

    const deps: GithubServiceDependencies = {
      authService: mockAuthService as unknown as GithubAuthProvider,
    };

    service = new GithubService(deps);
  });

  it('fetches PR diff and changed files', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: 'diff --git a/foo.ts b/foo.ts',
    });
    mockOctokit.rest.pulls.listFiles.mockResolvedValue({
      data: [{ filename: 'foo.ts' }],
    });

    const result = await service.getPRDiff('owner', 'repo', 1);

    expect(result.diff).toBe('diff --git a/foo.ts b/foo.ts');
    expect(result.changedFiles).toEqual(['foo.ts']);
    expect(mockAuthService.getOctokit).toHaveBeenCalledWith('owner', 'repo');
    expect(mockOctokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 1,
      mediaType: { format: 'diff' },
    });
  });

  it('searches code in repository', async () => {
    mockOctokit.rest.search.code.mockResolvedValue({
      data: {
        total_count: 1,
        items: [
          {
            name: 'foo.ts',
            path: 'src/foo.ts',
            sha: 'sha1',
            html_url: 'https://github.com/owner/repo/blob/main/src/foo.ts',
          },
        ],
      },
    });

    const result = await service.searchCode('owner', 'repo', 'calculateTax');

    expect(result.totalCount).toBe(1);
    expect(result.items[0].path).toBe('src/foo.ts');
    expect(mockAuthService.getOctokit).toHaveBeenCalledWith('owner', 'repo');
    expect(mockOctokit.rest.search.code).toHaveBeenCalledWith({
      q: 'calculateTax repo:owner/repo',
    });
  });

  it('fetches and decodes base64 file content', async () => {
    const rawCode = 'console.log("hello");';
    const base64Code = Buffer.from(rawCode).toString('base64');
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: {
        path: 'src/index.ts',
        content: base64Code,
        encoding: 'base64',
        sha: 'sha123',
      },
    });

    const result = await service.getFileContent(
      'owner',
      'repo',
      'src/index.ts',
    );

    expect(result.path).toBe('src/index.ts');
    expect(result.content).toBe(rawCode);
    expect(mockAuthService.getOctokit).toHaveBeenCalledWith('owner', 'repo');
  });

  it('fetches PR files and their contents', async () => {
    mockOctokit.rest.pulls.listFiles.mockResolvedValue({
      data: [
        { filename: 'deleted.ts', status: 'removed' },
        { filename: 'app.ts', status: 'modified' },
      ],
    });
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: {
        path: 'app.ts',
        content: Buffer.from('const a = 1;').toString('base64'),
        encoding: 'base64',
      },
    });

    const result = await service.getPRFiles('owner', 'repo', 1);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ filename: 'deleted.ts', status: 'removed' });
    expect(result[1]).toEqual({
      filename: 'app.ts',
      status: 'modified',
      content: 'const a = 1;',
      patch: undefined,
    });
  });

  it('downloads repo tarball archive', async () => {
    const mockData = new Uint8Array([1, 2, 3]);
    mockOctokit.rest.repos.downloadTarballArchive.mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'application/x-gzip',
        'x-github-commit-sha': 'sha12345',
      },
      data: mockData,
    });

    const result = await service.getRepoTarball('owner', 'repo', 'main');

    expect(mockAuthService.getOctokit).toHaveBeenCalledWith('owner', 'repo');
    expect(mockOctokit.rest.repos.downloadTarballArchive).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'main',
      request: {
        parseSuccessResponseBody: false,
      },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('application/x-gzip');
    expect(result.headers.get('x-github-commit-sha')).toBe('sha12345');
  });

  it('downloads repo tarball archive with default ref if omitted', async () => {
    mockOctokit.rest.repos.downloadTarballArchive.mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'application/x-gzip',
      },
      data: new Uint8Array(),
    });

    await service.getRepoTarball('owner', 'repo');

    expect(mockOctokit.rest.repos.downloadTarballArchive).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'main',
      request: {
        parseSuccessResponseBody: false,
      },
    });
  });

  it('posts review and inline comments atomically in a single createReview call', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: { head: { sha: 'commit-sha-1' } },
    });
    mockOctokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 99 },
    });

    const result = await service.postReview({
      owner: 'acme',
      repo: 'widget',
      prNumber: 7,
      summary: 'All good',
      comments: [{ path: 'src/a.ts', line: 12, body: 'Nit' }],
    });

    expect(result.success).toBe(true);
    expect(result.reviewId).toBe('99');
    expect(mockAuthService.getOctokit).toHaveBeenCalledWith('acme', 'widget');
    expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widget',
        pull_number: 7,
        commit_id: 'commit-sha-1',
        comments: [{ path: 'src/a.ts', line: 12, body: 'Nit' }],
      }),
    );
    expect(mockOctokit.rest.pulls.createReviewComment).not.toHaveBeenCalled();
  });

  it('falls back to summary review + per-comment createReviewComment when batched createReview fails with 422', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: { head: { sha: 'commit-sha-1' } },
    });
    mockOctokit.rest.pulls.createReview
      .mockRejectedValueOnce(
        Object.assign(new Error('Unprocessable Entity'), { status: 422 }),
      )
      .mockResolvedValueOnce({ data: { id: 99 } });
    mockOctokit.rest.pulls.createReviewComment.mockResolvedValue({
      data: { id: 100 },
    });

    const result = await service.postReview({
      owner: 'acme',
      repo: 'widget',
      prNumber: 7,
      summary: 'All good',
      comments: [{ path: 'src/a.ts', line: 12, body: 'Nit' }],
    });

    expect(result.success).toBe(true);
    expect(result.reviewId).toBe('99');
    expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(2);
    expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledTimes(1);
  });

  it('propagates GithubAppNotInstalledError from postReview without swallowing it', async () => {
    mockAuthService.getOctokit.mockRejectedValueOnce(
      new GithubAppNotInstalledError('uninstalled', 'repo'),
    );

    await expect(
      service.postReview({
        owner: 'uninstalled',
        repo: 'repo',
        prNumber: 1,
        summary: 'Summary',
        comments: [],
      }),
    ).rejects.toThrow('GitHub App is not installed on uninstalled/repo');
  });

  it('rethrows transient 5xx/429 errors during review submission so Pub/Sub retries', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: { head: { sha: 'commit-sha-1' } },
    });
    const rateLimitError = Object.assign(new Error('Rate limit exceeded'), {
      status: 429,
    });
    mockOctokit.rest.pulls.createReview.mockRejectedValueOnce(rateLimitError);

    await expect(
      service.postReview({
        owner: 'acme',
        repo: 'widget',
        prNumber: 7,
        summary: 'Summary',
        comments: [],
      }),
    ).rejects.toBe(rateLimitError);
  });
});
