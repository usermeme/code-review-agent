import { DatabaseService } from '../interfaces/database.interface.js';
import { RepositoryContext } from 'shared-types';

export class ContextRepository {
  private collection = 'repository_contexts';

  constructor(private db: DatabaseService) {}

  async saveContext(
    prKey: string,
    contextData: Omit<RepositoryContext, 'prKey' | 'updatedAt'>,
  ): Promise<void> {
    await this.db.setDocument<RepositoryContext>(this.collection, prKey, {
      prKey,
      ...contextData,
      updatedAt: new Date(),
    });
  }

  async getContext(prKey: string): Promise<RepositoryContext | null> {
    return this.db.getDocument<RepositoryContext>(this.collection, prKey);
  }
}
