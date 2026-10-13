import { describe, expect, it } from 'vitest';

import type { DatabaseService } from '../interfaces/database.interface.js';
import { LeaseRepository } from './lease.repository.js';

/** Minimal single-collection store with the same updateIf contract as Firestore. */
function createDb(): DatabaseService {
  const docs = new Map<string, object>();
  return {
    connect: async () => undefined,
    setDocument: async () => undefined,
    getDocument: async <T>(_c: string, id: string) =>
      (docs.get(id) as T | undefined) ?? null,
    updateIf: async <T extends object>(
      _c: string,
      id: string,
      decide: (current: T | null) => Partial<T> | null,
    ) => {
      const patch = decide((docs.get(id) as T | undefined) ?? null);
      if (!patch) return false;
      docs.set(id, { ...docs.get(id), ...patch });
      return true;
    },
  };
}

describe('LeaseRepository', () => {
  it('gives the lease to one holder at a time until it is released', async () => {
    const leases = new LeaseRepository(createDb(), () => 1_000);

    expect(await leases.tryAcquire('repo', 'a', 60_000)).toBe(true);
    expect(await leases.tryAcquire('repo', 'b', 60_000)).toBe(false);

    await leases.release('repo', 'a');
    expect(await leases.tryAcquire('repo', 'b', 60_000)).toBe(true);
  });

  it('lets another holder take over an expired lease', async () => {
    let now = 1_000;
    const leases = new LeaseRepository(createDb(), () => now);
    await leases.tryAcquire('repo', 'crashed', 60_000);

    now += 60_001;

    expect(await leases.tryAcquire('repo', 'b', 60_000)).toBe(true);
  });

  it('ignores a release from a holder that lost the lease', async () => {
    let now = 1_000;
    const leases = new LeaseRepository(createDb(), () => now);
    await leases.tryAcquire('repo', 'slow', 60_000);
    now += 60_001;
    await leases.tryAcquire('repo', 'new', 60_000);

    await leases.release('repo', 'slow');

    expect(await leases.tryAcquire('repo', 'third', 60_000)).toBe(false);
  });
});
