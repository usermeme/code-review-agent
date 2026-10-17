import { DatabaseService } from '../interfaces/database.interface.js';

/**
 * In-memory DatabaseService double for repository unit tests. Mirrors the
 * Firestore semantics the repositories rely on: merge-set, atomic
 * create-if-missing, and capped equality queries.
 */
export class InMemoryDatabaseService implements DatabaseService {
  readonly collections = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();

  async connect(): Promise<void> {
    // no-op
  }

  async setDocument<T extends object>(
    collection: string,
    docId: string,
    data: Partial<T>,
  ): Promise<void> {
    const col = this.collection(collection);
    col.set(docId, {
      ...(col.get(docId) ?? {}),
      ...(data as Record<string, unknown>),
    });
  }

  async getDocument<T>(collection: string, docId: string): Promise<T | null> {
    return (
      (this.collections.get(collection)?.get(docId) as T | undefined) ?? null
    );
  }

  async createDocumentIfMissing<T extends object>(
    collection: string,
    docId: string,
    data: T,
  ): Promise<boolean> {
    const col = this.collection(collection);
    if (col.has(docId)) {
      return false;
    }
    col.set(docId, { ...(data as Record<string, unknown>) });
    return true;
  }

  async deleteDocument(collection: string, docId: string): Promise<void> {
    this.collections.get(collection)?.delete(docId);
  }

  async findDocuments<T>(
    collection: string,
    field: string,
    value: unknown,
    limit: number,
  ): Promise<T[]> {
    const docs = [...(this.collections.get(collection)?.values() ?? [])];
    return docs.filter((doc) => doc[field] === value).slice(0, limit) as T[];
  }

  private collection(name: string): Map<string, Record<string, unknown>> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map();
      this.collections.set(name, col);
    }
    return col;
  }
}
