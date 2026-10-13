import type { RepoContext } from '@code-review-agent/shared-types';

import { DatabaseService } from '../interfaces/database.interface.js';

export class ContextRepository {
  private collection = 'repository_contexts';

  constructor(private db: DatabaseService) {}

  async save(context: RepoContext): Promise<void> {
    await this.db.setDocument<RepoContext>(
      this.collection,
      context.repoKey,
      context,
      false,
    );
  }

  async get(repoKey: string): Promise<RepoContext | null> {
    return this.db.getDocument<RepoContext>(this.collection, repoKey);
  }
}
