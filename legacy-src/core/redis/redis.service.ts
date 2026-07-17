import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3 });
}

/**
 * Deletes the lock key only while it still holds the caller's token. An
 * unconditional DEL would release a lock the caller no longer owns: if the
 * TTL expired mid-work, the key now belongs to whoever acquired it next.
 */
const RELEASE_IF_OWNER =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end';

export async function acquireLock(
  redis: Redis,
  key: string,
  ttlSeconds: number,
): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, 'EX', ttlSeconds, 'NX');
  if (result === 'OK') {
    return token;
  }
  return null;
}

export async function releaseLock(
  redis: Redis,
  key: string,
  token: string,
): Promise<void> {
  await redis.eval(RELEASE_IF_OWNER, 1, key, token);
}
