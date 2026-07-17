import type { Redis } from 'ioredis';
/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';

import { acquireReviewLock, releaseReviewLock } from './review-lock.service.js';

/** In-memory stand-in for the two Redis commands the locks use. */
class FakeRedis {
  readonly store = new Map<string, string>();

  async set(
    key: string,
    value: string,
    ..._args: unknown[]
  ): Promise<'OK' | null> {
    if (this.store.has(key)) return null; // NX
    this.store.set(key, value);
    return 'OK';
  }

  /** Mirrors the compare-and-delete the RELEASE_IF_OWNER Lua script performs. */
  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    token: string,
  ): Promise<number> {
    if (this.store.get(key) !== token) return 0;
    this.store.delete(key);
    return 1;
  }
}

describe('review lock', () => {
  it('is exclusive per repo/pr/sha and reacquirable after release', async () => {
    const redis = new FakeRedis() as unknown as Redis;
    const token = await acquireReviewLock(redis, 'o/r', 1, 'abc');
    expect(token).toBeTruthy();
    expect(await acquireReviewLock(redis, 'o/r', 1, 'abc')).toBeNull();
    expect(await acquireReviewLock(redis, 'o/r', 1, 'def')).toBeTruthy();

    await releaseReviewLock(redis, 'o/r', 1, 'abc', token!);
    expect(await acquireReviewLock(redis, 'o/r', 1, 'abc')).toBeTruthy();
  });

  it('does not release a lock the caller no longer owns', async () => {
    const fake = new FakeRedis();
    const redis = fake as unknown as Redis;
    const staleToken = await acquireReviewLock(redis, 'o/r', 1, 'abc');

    // The TTL expires mid-review and another run takes the lock.
    fake.store.clear();
    const currentToken = await acquireReviewLock(redis, 'o/r', 1, 'abc');
    expect(currentToken).toBeTruthy();

    await releaseReviewLock(redis, 'o/r', 1, 'abc', staleToken!);
    expect(fake.store.size).toBe(1); // the current owner's lock survives
    expect(await acquireReviewLock(redis, 'o/r', 1, 'abc')).toBeNull();
  });
});
