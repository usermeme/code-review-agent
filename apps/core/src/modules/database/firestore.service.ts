import { Firestore } from '@google-cloud/firestore';
import { FastifyBaseLogger } from 'fastify';

import { DatabaseService as IDatabaseService } from './interfaces/database.interface.js';

export class FirestoreDatabaseService implements IDatabaseService {
  private firestore: Firestore;

  constructor() {
    this.firestore = new Firestore();
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

  async updateIf<T extends object>(
    collection: string,
    docId: string,
    decide: (current: T | null) => Partial<T> | null,
  ): Promise<boolean> {
    const docRef = this.firestore.collection(collection).doc(docId);
    return this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      const patch = decide(snapshot.exists ? (snapshot.data() as T) : null);
      if (!patch) return false;
      tx.set(docRef, patch, { merge: true });
      return true;
    });
  }
}
