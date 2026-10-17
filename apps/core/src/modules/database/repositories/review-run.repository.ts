import { DatabaseService } from '../interfaces/database.interface.js';

/**
 * Exactly-once guard for expensive PR processing (LLM reviews, context
 * builds). Pub/Sub delivers at least once and redelivers on every timeout or
 * non-2xx response; without this guard each redelivery re-runs — and re-pays
 * for — the whole review, possibly in parallel with the original.
 */

/** Longer than the longest legitimate run, so a live run is never stolen. */
export const REVIEW_RUN_LEASE_MS = 15 * 60_000;
/** After this many failed attempts the run is abandoned, whatever the error. */
export const REVIEW_RUN_MAX_ATTEMPTS = 3;

export type ReviewRunStatus =
  'in_progress' | 'completed' | 'failed' | 'abandoned';

export interface ReviewRun {
  runKey: string;
  status: ReviewRunStatus;
  attempts: number;
  /** Epoch ms after which an `in_progress` run is presumed dead. */
  leaseExpiresAt: number;
  updatedAt: Date;
  error?: string;
}

export type AcquireReviewRunResult =
  | { acquired: true; attempt: number }
  | {
      acquired: false;
      reason: 'completed' | 'in_progress' | 'abandoned' | 'attempts_exhausted';
    };

export class ReviewRunRepository {
  private collection = 'review_runs';

  constructor(
    private db: DatabaseService,
    private now: () => number = Date.now,
  ) {}

  async acquire(runKey: string): Promise<AcquireReviewRunResult> {
    const now = this.now();
    return this.db.transactDocument<ReviewRun, AcquireReviewRunResult>(
      this.collection,
      runKey,
      (current) => {
        if (current?.status === 'completed') {
          return { result: { acquired: false, reason: 'completed' } };
        }
        if (current?.status === 'abandoned') {
          return { result: { acquired: false, reason: 'abandoned' } };
        }
        if (current?.status === 'in_progress' && current.leaseExpiresAt > now) {
          return { result: { acquired: false, reason: 'in_progress' } };
        }

        const attempts = current?.attempts ?? 0;
        if (attempts >= REVIEW_RUN_MAX_ATTEMPTS) {
          return {
            write: { status: 'abandoned', updatedAt: new Date(now) },
            result: { acquired: false, reason: 'attempts_exhausted' },
          };
        }

        return {
          write: {
            runKey,
            status: 'in_progress',
            attempts: attempts + 1,
            leaseExpiresAt: now + REVIEW_RUN_LEASE_MS,
            updatedAt: new Date(now),
          },
          result: { acquired: true, attempt: attempts + 1 },
        };
      },
    );
  }

  async complete(runKey: string): Promise<void> {
    await this.db.setDocument<ReviewRun>(this.collection, runKey, {
      status: 'completed',
      updatedAt: new Date(this.now()),
    });
  }

  /**
   * A retryable failure may be picked up again by a redelivery; a permanent
   * one never runs again (re-running a budget or timeout overrun would just
   * spend the same tokens a second time).
   */
  async fail(runKey: string, error: string, retryable: boolean): Promise<void> {
    await this.db.setDocument<ReviewRun>(this.collection, runKey, {
      status: retryable ? 'failed' : 'abandoned',
      error,
      updatedAt: new Date(this.now()),
    });
  }
}
