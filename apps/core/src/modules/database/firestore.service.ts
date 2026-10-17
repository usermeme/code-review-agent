import { Firestore } from '@google-cloud/firestore';
import { FastifyBaseLogger } from 'fastify';

import { DatabaseService as IDatabaseService } from './interfaces/database.interface.js';

export interface FirestoreDatabaseServiceDependencies {
  firestore: Firestore;
}

export class FirestoreDatabaseService implements IDatabaseService {
  private firestore: Firestore;

  constructor(deps: FirestoreDatabaseServiceDependencies) {
    this.firestore = deps.firestore;
  }

  async connect(logger: FastifyBaseLogger): Promise<void> {
    logger.info('Firestore initialized via Application Default Credentials');
  }

  async setDocument<T extends object>(
    collection: string,
    docId: string,
    data: Partial<T>,
    merge = true,
  ): Promise<void> {
    const docRef = this.firestore.collection(collection).doc(docId);
    await docRef.set(data, { merge });
  }

  async getDocument<T>(collection: string, docId: string): Promise<T | null> {
    const doc = await this.firestore.collection(collection).doc(docId).get();
    if (!doc.exists) {
      return null;
    }
    return doc.data() as T;
  }

  async createDocumentIfMissing<T extends object>(
    collection: string,
    docId: string,
    data: T,
  ): Promise<boolean> {
    try {
      await this.firestore.collection(collection).doc(docId).create(data);
      return true;
    } catch (err) {
      // gRPC code 6 = ALREADY_EXISTS — the atomic claim was lost, not an error.
      if ((err as { code?: number }).code === 6) {
        return false;
      }
      throw err;
    }
  }

  async deleteDocument(collection: string, docId: string): Promise<void> {
    await this.firestore.collection(collection).doc(docId).delete();
  }

  async findDocuments<T>(
    collection: string,
    field: string,
    value: unknown,
    limit: number,
  ): Promise<T[]> {
    const snapshot = await this.firestore
      .collection(collection)
      .where(field, '==', value)
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data() as T);
  }
}
