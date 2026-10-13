import { PRState } from '@code-review-agent/shared-types';

import { DatabaseService } from '../interfaces/database.interface.js';

export class PrRepository {
  private collection = 'pull_requests';

  constructor(private db: DatabaseService) {}

  async updatePRStatus(prKey: string, state: Partial<PRState>): Promise<void> {
    await this.db.setDocument<PRState>(
      this.collection,
      prKey,
      {
        ...state,
        updatedAt: new Date(),
      },
      true,
    );
  }

  /**
   * Moves a PR that waits for its baseline into `reviewing`. Only one caller
   * wins, so a redelivered context-build message can't review a PR twice.
   */
  async claimPendingReview(prKey: string): Promise<boolean> {
    return this.db.updateIf<PRState>(this.collection, prKey, (current) =>
      current?.status === 'building_context'
        ? { status: 'reviewing', updatedAt: new Date() }
        : null,
    );
  }

  async getPRStatus(prKey: string): Promise<PRState | null> {
    return this.db.getDocument<PRState>(this.collection, prKey);
  }
}
