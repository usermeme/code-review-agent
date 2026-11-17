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
  it('GET /repos/:owner/:repo/tree-files lists matching files of a ref', async () => {
    const listing = {
      files: [{ path: 'AGENTS.md', blobSha: 'a1' }],
      truncated: false,
    };
    mockGithubService.listTreeFiles = vi.fn().mockResolvedValue(listing);

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/tree-files?ref=main&names=agents.md,%20skill.md',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(listing);
    expect(mockGithubService.listTreeFiles).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      'main',
      ['agents.md', 'skill.md'],
    );
  });

  it('GET /repos/:owner/:repo/tree-files requires ref and names', async () => {
    mockGithubService.listTreeFiles = vi.fn();

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/tree-files?ref=main&names=',
    });

    expect(res.statusCode).toBe(400);
    expect(mockGithubService.listTreeFiles).not.toHaveBeenCalled();
  });

  it('GET /repos/:owner/:repo/blobs/:blobSha returns the blob content', async () => {
    mockGithubService.getBlob = vi.fn().mockResolvedValue('# Rules');

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/blobs/a1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blobSha: 'a1', content: '# Rules' });
  });

  it('GET /repos/:owner/:repo/blobs/:blobSha reports a provider failure', async () => {
    mockGithubService.getBlob = vi.fn().mockRejectedValue(new Error('boom'));

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/blobs/a1',
    });

    expect(res.statusCode).toBe(500);
  });
});
