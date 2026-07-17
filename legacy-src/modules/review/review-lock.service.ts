import type { Redis } from 'ioredis';
import { acquireLock, releaseLock } from '../../core/redis/redis.service.js';

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
  return releaseLock(
    redis,
    `review:lock:${repo}:${prNumber}:${headSha}`,
    token,
  );
}
