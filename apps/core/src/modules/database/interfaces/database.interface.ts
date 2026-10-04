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
}
