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
   * Atomically reads a document and, if `decide` returns a patch, merges it.
   * Returns whether the patch was written. Use it for check-then-act updates
   * (leases, status transitions) that two instances may race on.
   */
  updateIf<T extends object>(
    collection: string,
    docId: string,
    decide: (current: T | null) => Partial<T> | null,
  ): Promise<boolean>;
}
