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
    graphql: ReturnType<typeof vi.fn>;
    paginate: ReturnType<typeof vi.fn>;
    rest: {
      pulls: {
        get: ReturnType<typeof vi.fn>;
        listFiles: ReturnType<typeof vi.fn>;
        createReview: ReturnType<typeof vi.fn>;
        createReviewComment: ReturnType<typeof vi.fn>;
        listReviews: ReturnType<typeof vi.fn>;
        dismissReview: ReturnType<typeof vi.fn>;
      };
      repos: {
        downloadTarballArchive: ReturnType<typeof vi.fn>;
        compareCommitsWithBasehead: ReturnType<typeof vi.fn>;
      };
      git: {
        getTree: ReturnType<typeof vi.fn>;
        getBlob: ReturnType<typeof vi.fn>;
      };
      issues: {
        createComment: ReturnType<typeof vi.fn>;
      };
    };
  };

  beforeEach(() => {
    mockOctokit = {
      graphql: vi.fn(),
      paginate: vi.fn().mockResolvedValue([]),
      rest: {
        pulls: {
          get: vi.fn(),
          listFiles: vi.fn(),
          createReview: vi.fn(),
          createReviewComment: vi.fn(),
          listReviews: vi.fn(),
          dismissReview: vi.fn().mockResolvedValue({}),
        },
        repos: {
          downloadTarballArchive: vi.fn(),
          compareCommitsWithBasehead: vi.fn(),
        },
        git: {
          getTree: vi.fn(),
          getBlob: vi.fn(),
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

  it('compares two commits, returning the diff, changed files and status', async () => {
    // The diff request is issued first, then the JSON summary.
    mockOctokit.rest.repos.compareCommitsWithBasehead
      .mockResolvedValueOnce({ data: 'diff --git a/foo.ts b/foo.ts' })
      .mockResolvedValueOnce({
        data: { status: 'ahead', files: [{ filename: 'foo.ts' }] },
      });

    const result = await service.getCompareDiff('owner', 'repo', 'aaa', 'bbb');

    expect(result).toEqual({
      diff: 'diff --git a/foo.ts b/foo.ts',
      changedFiles: ['foo.ts'],
      status: 'ahead',
    });
    expect(
      mockOctokit.rest.repos.compareCommitsWithBasehead,
    ).toHaveBeenCalledWith(expect.objectContaining({ basehead: 'aaa...bbb' }));
  });

  it('lists the blobs of a ref whose basename matches, ignoring case', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValue({
      data: {
        truncated: false,
        tree: [
          { path: 'AGENTS.md', type: 'blob', sha: 'a1' },
          { path: '.agents/skills/x/SKILL.md', type: 'blob', sha: 'b2' },
          { path: 'src/index.ts', type: 'blob', sha: 'c3' },
          { path: 'docs/agents.md', type: 'tree', sha: 'd4' },
        ],
      },
    });

    const result = await service.listTreeFiles('owner', 'repo', 'main', [
      'agents.md',
      'skill.md',
    ]);

    expect(mockOctokit.rest.git.getTree).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      tree_sha: 'main',
      recursive: 'true',
    });
    expect(result).toEqual({
      truncated: false,
      files: [
        { path: 'AGENTS.md', blobSha: 'a1' },
        { path: '.agents/skills/x/SKILL.md', blobSha: 'b2' },
      ],
    });
  });

  it('decodes a base64 blob as UTF-8', async () => {
    mockOctokit.rest.git.getBlob.mockResolvedValue({
      data: { content: Buffer.from('Règle ✓', 'utf8').toString('base64') },
    });

    const content = await service.getBlob('owner', 'repo', 'a1');

    expect(content).toBe('Règle ✓');
    expect(mockOctokit.rest.git.getBlob).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      file_sha: 'a1',
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

  describe('approvals', () => {
    const BOT = 'review-bot[bot]';
    const CLEAN = {
      owner: 'acme',
      repo: 'widget',
      prNumber: 7,
      summary: 'No issues found.',
      comments: [],
      approve: true,
      reviewedSha: 'commit-sha-1',
    };

    function noThreads() {
      mockOctokit.graphql.mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }

    beforeEach(() => {
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: { head: { sha: 'commit-sha-1' } },
      });
      mockOctokit.rest.pulls.createReview.mockResolvedValue({
        data: { id: 99, user: { login: BOT } },
      });
    });

    it('approves a clean review on the reviewed commit', async () => {
      noThreads();

      const result = await service.postReview(CLEAN);

      expect(result.event).toBe('APPROVE');
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'APPROVE',
          commit_id: 'commit-sha-1',
        }),
      );
    });

    it('posts a comment with the reason when the head moved on', async () => {
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: { head: { sha: 'commit-sha-2' } },
      });

      const result = await service.postReview(CLEAN);

      expect(result.event).toBe('COMMENT');
      const params = mockOctokit.rest.pulls.createReview.mock.calls[0]?.[0];
      expect(params.event).toBe('COMMENT');
      expect(params.body).toContain('not approved: new commits were pushed');
    });

    it('still posts the review as a comment when GitHub rejects the approval', async () => {
      noThreads();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockOctokit.rest.pulls.createReview
        .mockRejectedValueOnce(
          Object.assign(new Error('Unprocessable Entity'), { status: 422 }),
        )
        .mockResolvedValueOnce({ data: { id: 100, user: { login: BOT } } });

      const result = await service.postReview(CLEAN);

      expect(result).toMatchObject({
        success: true,
        reviewId: '100',
        event: 'COMMENT',
      });
      const events = mockOctokit.rest.pulls.createReview.mock.calls.map(
        ([params]) => params.event,
      );
      expect(events).toEqual(['APPROVE', 'COMMENT']);
    });

    it("dismisses the bot's earlier approval when a new review has findings", async () => {
      mockOctokit.paginate.mockResolvedValue([
        { id: 5, state: 'APPROVED', user: { login: BOT } },
      ]);

      await service.postReview({
        owner: 'acme',
        repo: 'widget',
        prNumber: 7,
        summary: 'Found a bug.',
        comments: [{ path: 'src/a.ts', line: 12, body: 'Bug' }],
      });

      expect(mockOctokit.rest.pulls.dismissReview).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 7, review_id: 5 }),
      );
    });

    it('leaves earlier approvals alone when the new review has no findings', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { id: 5, state: 'APPROVED', user: { login: BOT } },
      ]);

      await service.postReview({ ...CLEAN, approve: false });

      expect(mockOctokit.paginate).not.toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.dismissReview).not.toHaveBeenCalled();
    });
  });
});
