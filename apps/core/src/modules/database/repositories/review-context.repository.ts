import type { ReviewContextDoc } from '@code-review-agent/shared-types';

import { DatabaseService } from '../interfaces/database.interface.js';

const COLLECTION = 'review_contexts';

export interface RepoRef {
  provider: string;
  owner: string;
  repo: string;
}

/** `github:owner:repo:<sourceHash>`: one document per distinct source set. */
export function reviewContextId(ref: RepoRef, sourceHash: string): string {
  return `${ref.provider}:${ref.owner}:${ref.repo}:${sourceHash}`;
}

/**
 * Stored review contexts. Documents are content-addressed by the hash of
 * their sources, so a write never races with a newer value: two instances
 * building the same hash write equivalent documents.
 */
export class ReviewContextRepository {
  constructor(private readonly db: DatabaseService) {}

  async get(id: string): Promise<ReviewContextDoc | null> {
    return this.db.getDocument<ReviewContextDoc>(COLLECTION, id);
  }

  /** Replaces the document, so a rebuild drops a failed build's fields. */
  async put(id: string, doc: ReviewContextDoc): Promise<void> {
    await this.db.replaceDocument<ReviewContextDoc>(COLLECTION, id, doc);
  }
}
