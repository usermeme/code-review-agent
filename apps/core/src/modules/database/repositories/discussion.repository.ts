import type {
  DiscussionHit,
  StoreDiscussionInput,
} from '@code-review-agent/agent-code-reviewer';

import { DatabaseService } from '../interfaces/database.interface.js';

/**
 * Persistence for the review-discussion memory behind the agent's
 * getDiscussion/storeDiscussion tools.
 *
 * Search is keyword-overlap scoring over a capped equality query — good
 * enough for "has the team already discussed something like this?" and cheap
 * to run. The {@link DiscussionHit} shape leaves room to swap in a real
 * semantic (embedding-based) backend later without touching the agent tools.
 */
export interface DiscussionRecord {
  repo: string;
  prNumber?: number;
  source: string;
  author: string;
  filePath?: string;
  body: string;
  createdAt: string;
}

const COLLECTION = 'review_discussions';
/** Max records pulled per search — discussions are small and recent-biased. */
const SEARCH_SCAN_LIMIT = 100;
/** Query tokens shorter than this carry no signal. */
const MIN_TOKEN_LENGTH = 4;

export class DiscussionRepository {
  constructor(private readonly db: DatabaseService) {}

  async store(entry: StoreDiscussionInput): Promise<boolean> {
    // Firestore doc ids cannot contain '/'; repo is "owner/name".
    const docId = [
      entry.repo.replace(/\//g, ':'),
      entry.prNumber ?? 0,
      Date.now(),
      Math.random().toString(36).slice(2, 8),
    ].join(':');
    await this.db.setDocument<DiscussionRecord>(COLLECTION, docId, {
      ...entry,
    });
    return true;
  }

  async search(
    repo: string,
    query: string,
    limit: number,
  ): Promise<DiscussionHit[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }

    const records = await this.db.findDocuments<DiscussionRecord>(
      COLLECTION,
      'repo',
      repo,
      SEARCH_SCAN_LIMIT,
    );

    const scored = records
      .map((record) => ({ record, score: scoreRecord(record, tokens) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ record, score }) => ({
      author: record.author,
      source: record.source,
      prNumber: record.prNumber,
      filePath: record.filePath,
      body: record.body,
      score,
    }));
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function scoreRecord(record: DiscussionRecord, tokens: string[]): number {
  const haystack = `${record.body} ${record.filePath ?? ''}`.toLowerCase();
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  return matches / tokens.length;
}
