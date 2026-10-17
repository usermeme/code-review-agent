import { describe, expect, it } from 'vitest';

import { DatabaseService } from '../interfaces/database.interface.js';
import {
  REVIEW_RUN_LEASE_MS,
  REVIEW_RUN_MAX_ATTEMPTS,
  ReviewRunRepository,
} from './review-run.repository.js';

class MapDatabase implements DatabaseService {
  docs = new Map<string, object>();
  async connect(): Promise<void> {}
  async setDocument<T extends object>(
    collection: string,
    docId: string,
    data: Partial<T>,
  ): Promise<void> {
    const key = `${collection}/${docId}`;
    this.docs.set(key, { ...this.docs.get(key), ...data });
  }
  async getDocument<T>(collection: string, docId: string): Promise<T | null> {
    return (this.docs.get(`${collection}/${docId}`) as T) ?? null;
  }
  async transactDocument<T extends object, R>(
    collection: string,
    docId: string,
    decide: (current: T | null) => { write?: Partial<T>; result: R },
  ): Promise<R> {
    const { write, result } = decide(
      await this.getDocument<T>(collection, docId),
    );
    if (write) await this.setDocument(collection, docId, write);
    return result;
  }
}

function setup() {
  let now = 1_000_000;
  const repo = new ReviewRunRepository(new MapDatabase(), () => now);
  return { repo, advance: (ms: number) => (now += ms) };
}

describe('ReviewRunRepository', () => {
  it('lets only the first caller run a key while its lease is live', async () => {
    const { repo } = setup();

    expect(await repo.acquire('k')).toEqual({ acquired: true, attempt: 1 });
    expect(await repo.acquire('k')).toEqual({
      acquired: false,
      reason: 'in_progress',
    });
  });

  it('never re-runs a completed key', async () => {
    const { repo, advance } = setup();
    await repo.acquire('k');
    await repo.complete('k');
    advance(REVIEW_RUN_LEASE_MS * 2);

    expect(await repo.acquire('k')).toEqual({
      acquired: false,
      reason: 'completed',
    });
  });

  it('takes over a run whose lease expired (crashed instance)', async () => {
    const { repo, advance } = setup();
    await repo.acquire('k');
    advance(REVIEW_RUN_LEASE_MS + 1);

    expect(await repo.acquire('k')).toEqual({ acquired: true, attempt: 2 });
  });

  it('retries a retryable failure until attempts run out', async () => {
    const { repo } = setup();
    for (let i = 1; i <= REVIEW_RUN_MAX_ATTEMPTS; i++) {
      expect(await repo.acquire('k')).toEqual({ acquired: true, attempt: i });
      await repo.fail('k', 'UNAVAILABLE', true);
    }

    expect(await repo.acquire('k')).toEqual({
      acquired: false,
      reason: 'attempts_exhausted',
    });
  });

  it('never retries a permanent failure', async () => {
    const { repo } = setup();
    await repo.acquire('k');
    await repo.fail('k', 'over budget', false);

    expect(await repo.acquire('k')).toEqual({
      acquired: false,
      reason: 'abandoned',
    });
  });
});
