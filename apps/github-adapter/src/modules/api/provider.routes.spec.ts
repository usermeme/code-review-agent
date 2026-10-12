import { Readable } from 'node:stream';

import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubService } from '../github/github.service.js';
import { providerRoutes } from './provider.routes.js';

describe('providerRoutes', () => {
  let app: FastifyInstance;
  let mockGithubService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    mockGithubService = {
      getPRDiff: vi.fn(),
      searchCode: vi.fn(),
      getFileContent: vi.fn(),
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

  it('GET /repos/:owner/:repo/search returns search results', async () => {
    mockGithubService.searchCode.mockResolvedValue({
      totalCount: 1,
      items: [{ name: 'file.ts', path: 'src/file.ts' }],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/search?q=AuthService',
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.totalCount).toBe(1);
    expect(mockGithubService.searchCode).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      'AuthService',
    );
  });

  it('GET /repos/:owner/:repo/files/* returns file contents', async () => {
    mockGithubService.getFileContent.mockResolvedValue({
      path: 'src/utils.ts',
      content: 'export const a = 1;',
      encoding: 'utf-8',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/files/src/utils.ts?ref=main',
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.content).toBe('export const a = 1;');
    expect(mockGithubService.getFileContent).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      'src/utils.ts',
      'main',
    );
  });

  it('GET /repos/:owner/:repo/pulls/:number/files returns PR files', async () => {
    mockGithubService.getPRFiles = vi.fn().mockResolvedValue([
      {
        filename: 'index.ts',
        status: 'modified',
        content: 'console.log(1);',
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/repos/test-owner/test-repo/pulls/42/files',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { filename: 'index.ts', status: 'modified', content: 'console.log(1);' },
    ]);
    expect(mockGithubService.getPRFiles).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      42,
    );
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
});
