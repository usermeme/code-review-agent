import { FastifyBaseLogger } from 'fastify';

import { DatabaseService } from '../../../../core/src/modules/database/interfaces/database.interface.js';

export class InMemoryDatabaseService implements DatabaseService {
  private collections = new Map<string, Map<string, object>>();

  async connect(_logger: FastifyBaseLogger): Promise<void> {
    void _logger;
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

  async transactDocument<T extends object, R>(
    collection: string,
    docId: string,
    decide: (current: T | null) => { write?: Partial<T>; result: R },
  ): Promise<R> {
    // Single-threaded and synchronous between the read and the write, so this
    // is atomic without a lock.
    const current = (this.collections.get(collection)?.get(docId) ??
      null) as T | null;
    const { write, result } = decide(current);
    if (write) await this.setDocument(collection, docId, write, true);
    return result;
  }

  clear(): void {
    this.collections.clear();
  }
}
