import { InMemoryDatabaseService as CoreInMemoryDatabaseService } from '../../../../core/src/modules/database/testing/in-memory-database.service.js';

/**
 * Shares the in-memory DatabaseService double with core's unit tests and
 * adds a reset helper for between-scenario cleanup.
 */
export class InMemoryDatabaseService extends CoreInMemoryDatabaseService {
  clear(): void {
    this.collections.clear();
  }
}
