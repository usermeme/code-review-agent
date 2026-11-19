import type { ThreadJudgmentDoc } from '@code-review-agent/shared-types';

import { DatabaseService } from '../interfaces/database.interface.js';

const COLLECTION = 'thread_judgments';
/** Threads read per PR at most; GitHub threads beyond this are rare. */
const MAX_THREADS_PER_PR = 500;

export function threadJudgmentId(prKey: string, threadId: string): string {
  return `${prKey}:${threadId}`;
}

/**
 * The comment judge's state per review thread. Writes merge only the given
 * fields, so instances judging different threads of a PR never clobber
 * each other.
 */
export class ThreadJudgmentRepository {
  constructor(private readonly db: DatabaseService) {}

  async get(id: string): Promise<ThreadJudgmentDoc | null> {
    return this.db.getDocument<ThreadJudgmentDoc>(COLLECTION, id);
  }

  async findByPr(prKey: string): Promise<ThreadJudgmentDoc[]> {
    return this.db.findDocuments<ThreadJudgmentDoc>(
      COLLECTION,
      'prKey',
      prKey,
      MAX_THREADS_PER_PR,
    );
  }

  async save(id: string, fields: Partial<ThreadJudgmentDoc>): Promise<void> {
    await this.db.setDocument<ThreadJudgmentDoc>(COLLECTION, id, {
      ...fields,
      updatedAt: new Date(),
    });
  }
}
