import { FastifyBaseLogger } from 'fastify';

export interface DatabaseService {
  connect(logger: FastifyBaseLogger): Promise<void>;
  setDocument<T extends object>(
    collection: string,
    docId: string,
    data: Partial<T>,
    merge?: boolean,
  ): Promise<void>;
  getDocument<T>(collection: string, docId: string): Promise<T | null>;
  /**
   * Reads a document and conditionally writes it back atomically: concurrent
   * callers on the same document see each other's writes, never a stale read.
   */
  transactDocument<T extends object, R>(
    collection: string,
    docId: string,
    decide: (current: T | null) => { write?: Partial<T>; result: R },
  ): Promise<R>;
}
