export interface DatabaseService {
  /**
   * Initializes the database connection.
   */
  connect(logger?: { info: (msg: string) => void }): Promise<void>;

  /**
   * Set or update a document in a collection.
   */
  setDocument<T extends object>(
    collection: string,
    docId: string,
    data: Partial<T>,
    merge?: boolean,
  ): Promise<void>;

  /**
   * Retrieve a document from a collection.
   */
  getDocument<T>(collection: string, docId: string): Promise<T | null>;
}
