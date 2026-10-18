import { generateKeyPairSync } from 'node:crypto';

import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import { Octokit } from 'octokit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GithubAppClient,
  GithubAppNotInstalledError,
  GithubAuthService,
} from './github-auth.service.js';

describe('GithubAuthService', () => {
  let getRepoInstallation: ReturnType<typeof vi.fn>;
  let getInstallationOctokit: ReturnType<typeof vi.fn>;
  let mockApp: GithubAppClient;
  let authService: GithubAuthService;

  beforeEach(() => {
    getRepoInstallation = vi.fn();
    getInstallationOctokit = vi.fn();
    mockApp = {
      octokit: {
        rest: {
          apps: {
            getRepoInstallation,
          },
        },
      },
      getInstallationOctokit,
    } as unknown as GithubAppClient;
    authService = new GithubAuthService({ app: mockApp });
  });

  it('resolves installation Octokit and caches it per owner/repo', async () => {
    const fakeOctokit = { rest: {} } as unknown as Octokit;
    getRepoInstallation.mockResolvedValue({ data: { id: 101 } });
    getInstallationOctokit.mockResolvedValue(fakeOctokit);

    const first = await authService.getOctokit('acme', 'service-a');
    const second = await authService.getOctokit('acme', 'service-a');

    expect(first).toBe(fakeOctokit);
    expect(second).toBe(fakeOctokit);
    expect(getRepoInstallation).toHaveBeenCalledTimes(1);
    expect(getRepoInstallation).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'service-a',
    });
    expect(getInstallationOctokit).toHaveBeenCalledTimes(1);
    expect(getInstallationOctokit).toHaveBeenCalledWith(101);
  });

  it('resolves separate installations for repos across different orgs/installations', async () => {
    const octokitA = { id: 'octokit-a' } as unknown as Octokit;
    const octokitB = { id: 'octokit-b' } as unknown as Octokit;

    getRepoInstallation
      .mockResolvedValueOnce({ data: { id: 101 } })
      .mockResolvedValueOnce({ data: { id: 202 } });
    getInstallationOctokit
      .mockResolvedValueOnce(octokitA)
      .mockResolvedValueOnce(octokitB);

    const resolvedA = await authService.getOctokit('org-a', 'repo-a');
    const resolvedB = await authService.getOctokit('org-b', 'repo-b');

    expect(resolvedA).toBe(octokitA);
    expect(resolvedB).toBe(octokitB);
    expect(getInstallationOctokit).toHaveBeenNthCalledWith(1, 101);
    expect(getInstallationOctokit).toHaveBeenNthCalledWith(2, 202);
  });

  it('reuses a single installation Octokit across multiple repos in the same installation', async () => {
    const sharedOctokit = { id: 'shared-org-octokit' } as unknown as Octokit;
    getRepoInstallation.mockResolvedValue({ data: { id: 101 } });
    getInstallationOctokit.mockResolvedValue(sharedOctokit);

    const repo1 = await authService.getOctokit('acme', 'repo-1');
    const repo2 = await authService.getOctokit('acme', 'repo-2');
    const repo1Upper = await authService.getOctokit('ACME', 'REPO-1');

    expect(repo1).toBe(sharedOctokit);
    expect(repo2).toBe(sharedOctokit);
    expect(repo1Upper).toBe(sharedOctokit);
    expect(getRepoInstallation).toHaveBeenCalledTimes(2);
    expect(getInstallationOctokit).toHaveBeenCalledTimes(1);
    expect(getInstallationOctokit).toHaveBeenCalledWith(101);
  });

  it('throws non-retryable GithubAppNotInstalledError on 404 installation lookup', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), {
      status: 404,
    });
    getRepoInstallation.mockRejectedValue(notFoundError);

    const promise = authService.getOctokit('uninstalled-org', 'missing-repo');

    await expect(promise).rejects.toBeInstanceOf(GithubAppNotInstalledError);
    await expect(promise).rejects.toBeInstanceOf(NonRetryableTaskError);
    await expect(promise).rejects.toThrow(
      'GitHub App is not installed on uninstalled-org/missing-repo',
    );
  });

  it('evicts failed lookups from cache and rethrows transient errors as retryable', async () => {
    const transientError = Object.assign(new Error('Bad Gateway'), {
      status: 502,
    });
    const recoveredOctokit = { rest: {} } as unknown as Octokit;

    getRepoInstallation
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ data: { id: 303 } });
    getInstallationOctokit.mockResolvedValue(recoveredOctokit);

    const firstAttempt = authService.getOctokit('acme', 'flaky-repo');
    await expect(firstAttempt).rejects.toBe(transientError);
    await expect(firstAttempt).rejects.not.toBeInstanceOf(
      NonRetryableTaskError,
    );

    const secondAttempt = await authService.getOctokit('acme', 'flaky-repo');
    expect(secondAttempt).toBe(recoveredOctokit);
    expect(getRepoInstallation).toHaveBeenCalledTimes(2);
  });

  it('constructs an Octokit App instance from appId and base64-encoded privateKey', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const base64Key = Buffer.from(privateKey, 'utf8').toString('base64');

    const service = new GithubAuthService({
      appId: '98765',
      privateKey: base64Key,
    });

    expect(service).toBeInstanceOf(GithubAuthService);
  });

  it('refreshes installation lookup after TTL expires or invalidate is called', async () => {
    const fakeOctokit = { rest: {} } as unknown as Octokit;
    getRepoInstallation
      .mockResolvedValueOnce({ data: { id: 101 } })
      .mockResolvedValueOnce({ data: { id: 102 } })
      .mockResolvedValueOnce({ data: { id: 103 } });
    getInstallationOctokit.mockResolvedValue(fakeOctokit);

    const shortTtlService = new GithubAuthService({
      app: mockApp,
      installationCacheTtlMs: 0,
    });

    await shortTtlService.getOctokit('acme', 'transferred-repo');
    await shortTtlService.getOctokit('acme', 'transferred-repo');
    expect(getRepoInstallation).toHaveBeenCalledTimes(2);

    authService.invalidate('acme', 'service-a');
    await authService.getOctokit('acme', 'service-a');
    expect(getRepoInstallation).toHaveBeenCalledTimes(3);
  });
});
