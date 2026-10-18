import { FastifyBaseLogger } from 'fastify';

export interface DatabaseService {
  connect(logger: FastifyBaseLogger): Promise<void>;
  setDocument<T extends object>(
    collection: string,
    docId: string,
    data: Partial<T>,
  ): Promise<void>;
  getDocument<T>(collection: string, docId: string): Promise<T | null>;
  /**
   * Atomically creates a document, failing on an existing id. Resolves true
   * when this call created it, false when the document already exists.
   */
  createDocumentIfMissing<T extends object>(
    collection: string,
    docId: string,
    data: T,
  ): Promise<boolean>;
  deleteDocument(collection: string, docId: string): Promise<void>;
  /** Equality query, capped — used for small operational lookups. */
  findDocuments<T>(
    collection: string,
    field: string,
    value: unknown,
    limit: number,
  ): Promise<T[]>;
}
