import type { Redis } from 'ioredis';
import { acquireLock, releaseLock } from '../../core/redis/redis.service.js';
import type { RepoContextDoc } from './repo-context-builder.service.js';

const VERSION = 'v1';

export class RepoContextCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly maxAgeSeconds: number,
  ) {}

  private key(repo: string, sha: string): string {
    return `repoctx:${VERSION}:${repo}:${sha}`;
  }

  private latestKey(repo: string): string {
    return `repoctx:${VERSION}:latest:${repo}`;
  }

  async get(repo: string, sha: string): Promise<RepoContextDoc | null> {
    const raw = await this.redis.get(this.key(repo, sha));
    return raw ? (JSON.parse(raw) as RepoContextDoc) : null;
  }

  async getLatest(repo: string): Promise<RepoContextDoc | null> {
    const sha = await this.redis.get(this.latestKey(repo));
    return sha ? this.get(repo, sha) : null;
  }

  async getLatestFresh(repo: string): Promise<RepoContextDoc | null> {
    const doc = await this.getLatest(repo);
    if (!doc) return null;
    return Date.now() - Date.parse(doc.builtAt) < this.maxAgeSeconds * 1000
      ? doc
      : null;
  }

  async set(repo: string, sha: string, doc: RepoContextDoc): Promise<void> {
    await this.redis
      .multi()
      .set(this.key(repo, sha), JSON.stringify(doc), 'EX', this.ttlSeconds)
      .set(this.latestKey(repo), sha, 'EX', this.ttlSeconds)
      .exec();
  }

  tryAcquireBuildLock(repo: string): Promise<string | null> {
    return acquireLock(this.redis, `repoctx:building:${repo}`, 900);
  }

  releaseBuildLock(repo: string, token: string): Promise<void> {
    return releaseLock(this.redis, `repoctx:building:${repo}`, token);
  }
}
