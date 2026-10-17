import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryDatabaseService } from '../testing/in-memory-database.service.js';
import { BaselineLockRepository } from './baseline-lock.repository.js';

interface StoredLock {
  ownerId: string;
  acquiredAt: Date;
}

describe('BaselineLockRepository', () => {
  let db: InMemoryDatabaseService;
  let repo: BaselineLockRepository;

  beforeEach(() => {
    db = new InMemoryDatabaseService();
    repo = new BaselineLockRepository(db);
  });

  it('grants the lock to the first owner and refuses others while fresh', async () => {
    await expect(repo.tryAcquire('key-1', 'owner-a')).resolves.toBe(true);
    await expect(repo.tryAcquire('key-1', 'owner-b')).resolves.toBe(false);
  });

  it('allows takeover of an expired lock', async () => {
    await repo.tryAcquire('key-1', 'owner-a');
    await db.setDocument('baseline_locks', 'key-1', {
      acquiredAt: new Date(Date.now() - 21 * 60 * 1000),
    });
    await expect(repo.tryAcquire('key-1', 'owner-b')).resolves.toBe(true);
    const record = await db.getDocument<StoredLock>('baseline_locks', 'key-1');
    expect(record?.ownerId).toBe('owner-b');
  });

  it('release only deletes the lock for the current owner', async () => {
    await repo.tryAcquire('key-1', 'owner-a');
    await repo.release('key-1', 'owner-b');
    expect(
      await db.getDocument<StoredLock>('baseline_locks', 'key-1'),
    ).not.toBeNull();

    await repo.release('key-1', 'owner-a');
    expect(
      await db.getDocument<StoredLock>('baseline_locks', 'key-1'),
    ).toBeNull();
    await expect(repo.tryAcquire('key-1', 'owner-b')).resolves.toBe(true);
  });

  it('keeps locks for different baselines independent', async () => {
    await expect(repo.tryAcquire('key-1', 'owner-a')).resolves.toBe(true);
    await expect(repo.tryAcquire('key-2', 'owner-b')).resolves.toBe(true);
  });
});
