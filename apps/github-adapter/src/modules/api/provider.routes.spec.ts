import { Readable } from 'node:stream';

import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubService } from '../github/github.service.js';
import { GithubAppNotInstalledError } from '../github/github-auth.service.js';
import { providerRoutes } from './provider.routes.js';

describe('providerRoutes', () => {
  let app: FastifyInstance;
  let mockGithubService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    mockGithubService = {
      getPRDiff: vi.fn(),
    };

    app = Fastify();
    await app.register(providerRoutes, {
      githubService: mockGithubService as unknown as GithubService,
    });
  });

  it('GET /repos/:owner/:repo/pulls/:number/diff returns diff and files', async () => {
    mockGithubService.getPRDiff.mockResolvedValue({
      diff: 'diff-content',
      changedFiles: ['file.ts'],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/pulls/123/diff',
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.diff).toBe('diff-content');
    expect(json.changedFiles).toEqual(['file.ts']);
    expect(mockGithubService.getPRDiff).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      123,
    );
  });

  it('GET /repos/:owner/:repo/pulls/:number/threads returns review threads', async () => {
    const threads = [
      {
        id: 'T1',
        path: 'src/a.ts',
        line: 4,
        isResolved: false,
        isOutdated: false,
        comments: [{ author: 'octocat', body: 'Null check?' }],
      },
    ];
    mockGithubService.getReviewThreads = vi.fn().mockResolvedValue(threads);

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/pulls/123/threads',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(threads);
    expect(mockGithubService.getReviewThreads).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      123,
    );
  });

  it('GET /repos/:owner/:repo/compare returns the compare diff', async () => {
    const compare = { diff: 'd', changedFiles: ['a.ts'], status: 'ahead' };
    mockGithubService.getCompareDiff = vi.fn().mockResolvedValue(compare);

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/compare?base=aaa&head=bbb',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(compare);
    expect(mockGithubService.getCompareDiff).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      'aaa',
      'bbb',
    );
  });

  it('GET /repos/:owner/:repo/compare rejects a missing head', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/compare?base=aaa',
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /repos/:owner/:repo/tarball returns tarball stream', async () => {
    const mockStream = Readable.from([Buffer.from('fake-tar-bytes')]);
    mockGithubService.getRepoTarball = vi.fn().mockResolvedValue({
      body: mockStream,
      headers: {
        get: (h: string) => (h === 'x-github-commit-sha' ? 'sha-123' : null),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/tarball?ref=main',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-gzip');
    expect(res.headers['x-commit-sha']).toBe('sha-123');
    expect(mockGithubService.getRepoTarball).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      'main',
    );
  });

  it('returns 422 with nonRetryable: true when GitHub App is not installed', async () => {
    mockGithubService.getPRDiff.mockRejectedValueOnce(
      new GithubAppNotInstalledError('uninstalled-owner', 'uninstalled-repo'),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/repos/uninstalled-owner/uninstalled-repo/pulls/123/diff',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error:
        'GitHub App is not installed on uninstalled-owner/uninstalled-repo',
      nonRetryable: true,
    });
  });
  it('GET /repos/:owner/:repo/contents returns a file at a ref', async () => {
    mockGithubService.getFileContent = vi
      .fn()
      .mockResolvedValue('const a = 1;');

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/contents?path=src%2Fa.ts&ref=sha1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      path: 'src/a.ts',
      ref: 'sha1',
      content: 'const a = 1;',
    });
    expect(mockGithubService.getFileContent).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      'src/a.ts',
      'sha1',
    );
  });

  it('GET /repos/:owner/:repo/contents requires path and ref', async () => {
    mockGithubService.getFileContent = vi.fn();

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/contents?path=src%2Fa.ts',
    });

    expect(res.statusCode).toBe(400);
    expect(mockGithubService.getFileContent).not.toHaveBeenCalled();
  });
});
