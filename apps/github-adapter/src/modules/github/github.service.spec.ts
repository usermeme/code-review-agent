import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GithubService, GithubServiceDependencies } from './github.service.js';
import { Octokit } from '@octokit/rest';
import { AdapterEnvService } from '../../env.js';

describe('GithubService (Adapter)', () => {
  let service: GithubService;
  let mockOctokit: any;
  let mockEnvService: any;

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
      envService: mockEnvService as AdapterEnvService,
      octokit: mockOctokit as Octokit,
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

  it('downloads repo tarball archive', async () => {
    const mockFetchResponse = {
      ok: true,
      status: 200,
    };
    global.fetch = vi.fn().mockResolvedValue(mockFetchResponse);

    const result = await service.getRepoTarball('owner', 'repo', 'main');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/tarball/main',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    expect(result).toBe(mockFetchResponse);
  });
});
