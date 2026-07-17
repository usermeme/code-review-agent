import { Firestore } from '@google-cloud/firestore';
import { DatabaseService as IDatabaseService, PRState } from './interfaces/database.interface.js';

export class FirestoreDatabaseService implements IDatabaseService {
  private firestore: Firestore;

  constructor() {
    this.firestore = new Firestore();
  }

  async connect(): Promise<void> {
    // Firestore initializes lazily, but we can verify credentials or simply do nothing.
    console.log('Firestore initialized via Application Default Credentials');
  }

  async updatePRStatus(prKey: string, state: Partial<PRState>): Promise<void> {
    const docRef = this.firestore.collection('pull_requests').doc(prKey);
    await docRef.set({
      ...state,
      updatedAt: new Date()
    }, { merge: true });
  }

  async getPRStatus(prKey: string): Promise<PRState | null> {
    const doc = await this.firestore.collection('pull_requests').doc(prKey).get();
    if (!doc.exists) {
      return null;
    }
    return doc.data() as PRState;
  }
}
