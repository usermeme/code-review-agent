import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import { App, Octokit } from 'octokit';

import { normalizePrivateKey } from '../../env.js';

export interface GithubAuthProvider {
  getOctokit(owner: string, repo: string): Promise<Octokit>;
  invalidate?(owner: string, repo: string): void;
}

export interface GithubAppClient {
  octokit: {
    rest: {
      apps: {
        getRepoInstallation(params: {
          owner: string;
          repo: string;
        }): Promise<{ data: { id: number } }>;
      };
    };
  };
  getInstallationOctokit(installationId: number): Promise<Octokit>;
}

export type GithubAuthServiceOptions = (
  | {
      appId: string;
      privateKey: string;
    }
  | {
      app: GithubAppClient;
    }
) & {
  installationCacheTtlMs?: number;
};

interface CachedInstallationEntry {
  promise: Promise<number>;
  expiresAt: number;
}

const DEFAULT_INSTALLATION_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Thrown when the configured GitHub App is not installed on the target
 * `owner/repo`. Extends {@link NonRetryableTaskError} so Pub/Sub push routes
 * ACK the delivery immediately instead of entering a redelivery loop.
 */
export class GithubAppNotInstalledError extends NonRetryableTaskError {
  constructor(owner: string, repo: string, options?: { cause?: unknown }) {
    super(`GitHub App is not installed on ${owner}/${repo}`, options);
    this.name = 'GithubAppNotInstalledError';
  }
}

function isNotFoundError(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

function toRepoKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function resolveAppClient(options: GithubAuthServiceOptions): GithubAppClient {
  if ('app' in options) {
    return options.app;
  }
  return new App({
    appId: options.appId,
    privateKey: normalizePrivateKey(options.privateKey),
  });
}

export class GithubAuthService implements GithubAuthProvider {
  private readonly app: GithubAppClient;
  private readonly installationCacheTtlMs: number;
  private readonly repoInstallationCache = new Map<
    string,
    CachedInstallationEntry
  >();
  private readonly installationOctokitCache = new Map<
    number,
    Promise<Octokit>
  >();

  constructor(options: GithubAuthServiceOptions) {
    this.app = resolveAppClient(options);
    this.installationCacheTtlMs =
      options.installationCacheTtlMs ?? DEFAULT_INSTALLATION_CACHE_TTL_MS;
  }

  async getOctokit(owner: string, repo: string): Promise<Octokit> {
    const installationId = await this.getInstallationId(owner, repo);
    return this.getOctokitForInstallation(installationId);
  }

  invalidate(owner: string, repo: string): void {
    this.repoInstallationCache.delete(toRepoKey(owner, repo));
  }

  private getInstallationId(owner: string, repo: string): Promise<number> {
    const repoKey = toRepoKey(owner, repo);
    const cached = this.getValidCachedInstallation(repoKey);
    if (cached !== undefined) {
      return cached;
    }

    const promise = this.fetchInstallationId(owner, repo).catch(
      (error: unknown) => {
        this.repoInstallationCache.delete(repoKey);
        throw error;
      },
    );
    this.repoInstallationCache.set(repoKey, {
      promise,
      expiresAt: Date.now() + this.installationCacheTtlMs,
    });
    return promise;
  }

  private getValidCachedInstallation(
    repoKey: string,
  ): Promise<number> | undefined {
    const entry = this.repoInstallationCache.get(repoKey);
    if (!entry || Date.now() >= entry.expiresAt) {
      return undefined;
    }
    return entry.promise;
  }

  private getOctokitForInstallation(installationId: number): Promise<Octokit> {
    const cached = this.installationOctokitCache.get(installationId);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.app
      .getInstallationOctokit(installationId)
      .catch((error: unknown) => {
        this.installationOctokitCache.delete(installationId);
        throw error;
      });
    this.installationOctokitCache.set(installationId, pending);
    return pending;
  }

  private async fetchInstallationId(
    owner: string,
    repo: string,
  ): Promise<number> {
    try {
      const { data } = await this.app.octokit.rest.apps.getRepoInstallation({
        owner,
        repo,
      });
      return data.id;
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new GithubAppNotInstalledError(owner, repo, { cause: error });
      }
      throw error;
    }
  }
}
