import { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdapterEnvService } from '../../env.js';
import { GithubService, GithubServiceDependencies } from './github.service.js';

describe('GithubService (Adapter)', () => {
  let service: GithubService;
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
  let mockEnvService: { get: ReturnType<typeof vi.fn> };

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

    mockEnvService = {
      get: vi.fn().mockReturnValue('test-token'),
    };

    const deps: GithubServiceDependencies = {
      envService: mockEnvService as unknown as AdapterEnvService,
      octokit: mockOctokit as unknown as Octokit,
      token: 'test-token',
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

  it('reads every page of PR files, not just the first', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/file-${i}.ts`,
      status: 'removed',
    }));
    mockOctokit.rest.pulls.listFiles
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({
        data: [{ filename: 'src/last.ts', status: 'removed' }],
      });

    const result = await service.getPRFiles('owner', 'repo', 1);

    expect(result).toHaveLength(101);
    expect(mockOctokit.rest.pulls.listFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ per_page: 100, page: 2 }),
    );
  });

  it('falls back to a single-line comment when GitHub rejects a line range', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: { head: { sha: 'sha1' } },
    });
    mockOctokit.rest.pulls.createReview.mockResolvedValue({ data: { id: 1 } });
    mockOctokit.rest.pulls.createReviewComment
      .mockRejectedValueOnce(new Error('422 line range spans hunks'))
      .mockResolvedValueOnce({});

    await service.postReview({
      owner: 'owner',
      repo: 'repo',
      prNumber: 1,
      summary: 'summary',
      comments: [{ path: 'a.ts', line: 12, startLine: 3, body: 'issue' }],
    });

    expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ start_line: 3, line: 12 }),
    );
    expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ start_line: expect.anything() }),
    );
    expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledTimes(2);
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
});
