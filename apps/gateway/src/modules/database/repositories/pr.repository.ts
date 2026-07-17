import { DatabaseService } from '../interfaces/database.interface.js';

export interface PRState {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  status: 'queued' | 'building_context' | 'reviewing' | 'completed' | 'failed';
  updatedAt: Date;
}

export class PrRepository {
  private collection = 'pull_requests';

  constructor(private db: DatabaseService) {}

  async updatePRStatus(prKey: string, state: Partial<PRState>): Promise<void> {
    await this.db.setDocument<PRState>(this.collection, prKey, {
      ...state,
      updatedAt: new Date()
    }, true);
  }

  async getPRStatus(prKey: string): Promise<PRState | null> {
    return this.db.getDocument<PRState>(this.collection, prKey);
  }
}
