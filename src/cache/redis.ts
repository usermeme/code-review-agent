import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { RepoContextDoc } from '../context/repo-context-builder.js';

const VERSION = 'v1';

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3 });
}

/**
 * Deletes the lock key only while it still holds the caller's token. An
 * unconditional DEL would release a lock the caller no longer owns: if the
 * TTL expired mid-work, the key now belongs to whoever acquired it next.
 */
const RELEASE_IF_OWNER = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end';

async function acquireLock(redis: Redis, key: string, ttlSeconds: number): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, 'EX', ttlSeconds, 'NX');
  return result === 'OK' ? token : null;
}

async function releaseLock(redis: Redis, key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_IF_OWNER, 1, key, token);
}

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

  /** The most recently built doc for the repo, however old it is. */
  async getLatest(repo: string): Promise<RepoContextDoc | null> {
    const sha = await this.redis.get(this.latestKey(repo));
    return sha ? this.get(repo, sha) : null;
  }

  /** The latest doc only when built within maxAgeSeconds — the rebuild threshold. */
  async getLatestFresh(repo: string): Promise<RepoContextDoc | null> {
    const doc = await this.getLatest(repo);
    if (!doc) return null;
    return Date.now() - Date.parse(doc.builtAt) < this.maxAgeSeconds * 1000 ? doc : null;
  }

  async set(repo: string, sha: string, doc: RepoContextDoc): Promise<void> {
    await this.redis
      .multi()
      .set(this.key(repo, sha), JSON.stringify(doc), 'EX', this.ttlSeconds)
      .set(this.latestKey(repo), sha, 'EX', this.ttlSeconds)
      .exec();
  }

  /**
   * Build mutex so concurrent reviews don't rebuild the same context.
   * Returns an ownership token to pass back to releaseBuildLock, or null
   * when another run holds the lock.
   */
  tryAcquireBuildLock(repo: string): Promise<string | null> {
    return acquireLock(this.redis, `repoctx:building:${repo}`, 900);
  }

  releaseBuildLock(repo: string, token: string): Promise<void> {
    return releaseLock(this.redis, `repoctx:building:${repo}`, token);
  }
}

/**
 * Idempotency guard: only the first delivery for a given head sha runs a
 * review. Expires after an hour so retries of genuinely failed runs work.
 * Returns an ownership token to pass back to releaseReviewLock, or null
 * when a review for this sha already ran.
 */
export function acquireReviewLock(
  redis: Redis,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<string | null> {
  return acquireLock(redis, `review:lock:${repo}:${prNumber}:${headSha}`, 3600);
}

export function releaseReviewLock(
  redis: Redis,
  repo: string,
  prNumber: number,
  headSha: string,
  token: string,
): Promise<void> {
  return releaseLock(redis, `review:lock:${repo}:${prNumber}:${headSha}`, token);
}
