import { PRState } from '@code-review-agent/shared-types';

import { DatabaseService } from '../interfaces/database.interface.js';

export class PrRepository {
  private collection = 'pull_requests';

  constructor(private db: DatabaseService) {}

  /**
   * Writes ONLY the given fields; Firestore `set(..., { merge: true })`
   * preserves every omitted field. Never write a full object assembled from
   * an in-memory copy here: this service runs multi-instance (see
   * BaselineLockRepository), and a stale local copy would clobber newer
   * field values written by other instances.
   */
  async updatePRStatus(prKey: string, state: Partial<PRState>): Promise<void> {
    await this.db.setDocument<PRState>(this.collection, prKey, {
      ...state,
      updatedAt: new Date(),
    });
  }

  async getPRStatus(prKey: string): Promise<PRState | null> {
    return this.db.getDocument<PRState>(this.collection, prKey);
  }

  async deletePRStatus(prKey: string): Promise<void> {
    await this.db.deleteDocument(this.collection, prKey);
  }
}
