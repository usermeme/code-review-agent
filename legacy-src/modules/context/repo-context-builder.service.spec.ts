/* eslint-disable @typescript-eslint/require-await */
import type { BaseLlm } from '@google/adk';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import {} from '../../core/redis/redis.service.js';
import {
  RepoContextBuilder,
  type RepoContextDoc,
} from './repo-context-builder.service.js';
import { RepoContextCache } from './repo-context-cache.service.js';

/** In-memory stand-in for the Redis commands the cache and locks use. */
class FakeRedis {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    ...args: unknown[]
  ): Promise<'OK' | null> {
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  multi() {
    const queued: Array<[string, string]> = [];
    const chain = {
      set: (key: string, value: string, ..._ttl: unknown[]) => {
        queued.push([key, value]);
        return chain;
      },
      exec: async () => {
        for (const [key, value] of queued) this.store.set(key, value);
        return [];
      },
    };
    return chain;
  }

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

const MAX_AGE_SECONDS = 60;

function doc(builtAt: string): RepoContextDoc {
  return {
    sections: { architecture: 'arch' },
    headSha: 'aaa',
    builtAt,
    model: 'm',
  };
}

function setup() {
  const redis = new FakeRedis();
  const cache = new RepoContextCache(
    redis as unknown as Redis,
    3600,
    MAX_AGE_SECONDS,
  );
  const builder = new RepoContextBuilder(cache, {} as BaseLlm, {
    maxChunkTokens: 1000,
    maxChunks: 1,
    summaryConcurrency: 1,
    extraIgnores: [],
  });
  return { redis, cache, builder };
}

// A clone target that fails fast: reaching the clone proves a rebuild was attempted.
const UNBUILDABLE = {
  repo: 'o/r',
  ref: 'main',
  cloneUrl: 'file:///nonexistent-repo',
};

describe('RepoContextBuilder.getOrBuild', () => {
  it('serves the latest doc while it is within max age', async () => {
    const { cache, builder } = setup();
    await cache.set('o/r', 'aaa', doc(new Date().toISOString()));
    const result = await builder.getOrBuild(UNBUILDABLE);
    expect(result.headSha).toBe('aaa');
  });

  it('rebuilds once the latest doc is past max age', async () => {
    const { redis, cache, builder } = setup();
    await cache.set(
      'o/r',
      'aaa',
      doc(new Date(Date.now() - 2 * MAX_AGE_SECONDS * 1000).toISOString()),
    );
    await expect(builder.getOrBuild(UNBUILDABLE)).rejects.toThrow(); // clone attempted and failed
    expect(redis.store.has('repoctx:building:o/r')).toBe(false); // build lock released
  });

  it('falls back to a stale doc while another run holds the build lock', async () => {
    const { cache, builder } = setup();
    await cache.set(
      'o/r',
      'aaa',
      doc(new Date(Date.now() - 2 * MAX_AGE_SECONDS * 1000).toISOString()),
    );
    expect(await cache.tryAcquireBuildLock('o/r')).toBeTruthy();
    const result = await builder.getOrBuild(UNBUILDABLE);
    expect(result.headSha).toBe('aaa');
  });

  it('throws when another run is building and nothing is cached yet', async () => {
    const { cache, builder } = setup();
    expect(await cache.tryAcquireBuildLock('o/r')).toBeTruthy();
    await expect(builder.getOrBuild(UNBUILDABLE)).rejects.toThrow(
      /being built by another run/,
    );
  });
});
