import { FastifyBaseLogger } from 'fastify';
import { DatabaseService } from '../../../../gateway/src/modules/database/interfaces/database.interface.js';

export class InMemoryDatabaseService implements DatabaseService {
  private collections = new Map<string, Map<string, any>>();

  async connect(_logger: FastifyBaseLogger): Promise<void> {
    void _logger;
    // In-memory connection is instantaneous
  }

  async setDocument<T extends object>(
    collection: string,
    docId: string,
    data: Partial<T>,
    merge = true,
  ): Promise<void> {
    let col = this.collections.get(collection);
    if (!col) {
      col = new Map();
      this.collections.set(collection, col);
    }
    if (merge && col.has(docId)) {
      const existing = col.get(docId);
      col.set(docId, { ...existing, ...data });
    } else {
      col.set(docId, { ...data });
    }
  }

  async getDocument<T>(collection: string, docId: string): Promise<T | null> {
    const col = this.collections.get(collection);
    if (!col || !col.has(docId)) {
      return null;
    }
    return col.get(docId) as T;
  }

  clear(): void {
    this.collections.clear();
  }
}
