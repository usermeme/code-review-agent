import { DatabaseService } from '../interfaces/database.interface.js';

/**
 * Cross-instance lock for baseline context builds.
 *
 * A baseline build costs dozens of LLM calls (tarball + per-file summaries).
 * The orchestrator dedupes in-flight builds per process, but with several
 * Cloud Run instances a burst of PR events for the same base commit would
 * trigger the same expensive build in parallel. This lock makes instances
 * wait for the winner's stored context instead.
 *
 * Locks are advisory and expire after {@link DEFAULT_TTL_MS}: a crashed
 * holder blocks nobody longer than the TTL, and waiters eventually build
 * anyway (correctness over dedup).
 */
export interface BaselineLockRecord {
  baselineKey: string;
  ownerId: string;
  acquiredAt: Date;
}

const COLLECTION = 'baseline_locks';
const DEFAULT_TTL_MS = 20 * 60 * 1000;

export class BaselineLockRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Attempts to acquire (or take over an expired) lock for `baselineKey`.
   * Returns true when this owner now holds the lock.
   */
  async tryAcquire(
    baselineKey: string,
    ownerId: string,
    ttlMs: number = DEFAULT_TTL_MS,
  ): Promise<boolean> {
    const created = await this.db.createDocumentIfMissing<BaselineLockRecord>(
      COLLECTION,
      baselineKey,
      { baselineKey, ownerId, acquiredAt: new Date() },
    );
    if (created) {
      return true;
    }

    const existing = await this.db.getDocument<BaselineLockRecord>(
      COLLECTION,
      baselineKey,
    );
    if (!existing) {
      // Deleted between the two calls — next attempt wins.
      return false;
    }
    const age = Date.now() - new Date(existing.acquiredAt).getTime();
    if (Number.isFinite(age) && age <= ttlMs) {
      return false;
    }
    // Expired lock — take it over (benign race: worst case two builds).
    await this.db.setDocument<BaselineLockRecord>(COLLECTION, baselineKey, {
      ownerId,
      acquiredAt: new Date(),
    });
    return true;
  }

  /** Releases the lock, but only when still owned by `ownerId`. */
  async release(baselineKey: string, ownerId: string): Promise<void> {
    const existing = await this.db.getDocument<BaselineLockRecord>(
      COLLECTION,
      baselineKey,
    );
    if (existing?.ownerId === ownerId) {
      await this.db
        .deleteDocument(COLLECTION, baselineKey)
        .catch(() => undefined);
    }
  }
}
