export interface PRState {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  status: 'queued' | 'building_context' | 'reviewing' | 'completed' | 'failed';
  updatedAt: Date;
}

export interface DatabaseService {
  /**
   * Initializes the database connection.
   */
  connect(): Promise<void>;

  /**
   * Updates the status of a Pull Request in the database.
   */
  updatePRStatus(prKey: string, state: Partial<PRState>): Promise<void>;
  
  /**
   * Retrieves the current status of a Pull Request.
   */
  getPRStatus(prKey: string): Promise<PRState | null>;
}
