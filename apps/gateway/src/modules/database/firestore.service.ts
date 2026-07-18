import { Firestore } from '@google-cloud/firestore';
import { DatabaseService as IDatabaseService } from './interfaces/database.interface.js';

export class FirestoreDatabaseService implements IDatabaseService {
  private firestore: Firestore;

  constructor() {
    this.firestore = new Firestore();
  }

  async connect(): Promise<void> {
    console.log('Firestore initialized via Application Default Credentials');
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
}
