import { DatabaseService } from '../interfaces/database.interface.js';

interface Lease {
  holder: string;
  expiresAt: number;
}

/**
 * Time-bounded exclusive leases, one per key. A lease outlives a crashed
 * holder only until it expires; `release` only clears a lease the caller
 * still holds, so a slow holder can't free a lease someone else took over.
 */
export class LeaseRepository {
  private collection = 'leases';

  constructor(
    private db: DatabaseService,
    private now: () => number = Date.now,
  ) {}

  async tryAcquire(
    key: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean> {
    const now = this.now();
    return this.db.updateIf<Lease>(this.collection, key, (current) =>
      current && current.holder !== holder && current.expiresAt > now
        ? null
        : { holder, expiresAt: now + ttlMs },
    );
  }

  async release(key: string, holder: string): Promise<void> {
    await this.db.updateIf<Lease>(this.collection, key, (current) =>
      current?.holder === holder ? { expiresAt: 0 } : null,
    );
  }
}
