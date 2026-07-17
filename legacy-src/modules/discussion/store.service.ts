import type pg from 'pg';
import { logger } from '../../core/logger/logger.service.js';
import type { Embedder } from './embeddings.service.js';

export type DiscussionSource =
  | 'issue_comment'
  | 'review_comment'
  | 'review'
  | 'bot_finding';

export interface DiscussionEntry {
  repo: string;
  prNumber?: number;
  source: DiscussionSource;
  author: string;
  filePath?: string;
  body: string;
  providerId?: string;
  platformInstallationId?: string;
  createdAt: Date;
}

export interface DiscussionHit extends DiscussionEntry {
  score: number;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** Row shape returned by the search query (bigint columns arrive as strings). */
interface DiscussionRow {
  repo: string;
  pr_number: number | null;
  source: DiscussionSource;
  author: string;
  file_path: string | null;
  body: string;
  provider_id: string | null;
  platform_installation_id: string | null;
  created_at: Date;
  score: string;
}

export class DiscussionStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embedder: Embedder,
  ) {}

  private getConflictClause(hasProviderId: boolean): string {
    if (hasProviderId) {
      return 'ON CONFLICT (provider_id) DO NOTHING';
    }
    return `ON CONFLICT (repo, source, coalesce(pr_number, -1), coalesce(file_path, ''), md5(body))
           WHERE provider_id IS NULL DO NOTHING`;
  }

  async insert(entry: DiscussionEntry): Promise<void> {
    const body = entry.body.trim();
    if (!body) return;
    // Rows without a provider id (bot findings) dedupe on content via the
    // partial unique index — a NULL provider_id never conflicts with anything.
    const onConflict = this.getConflictClause(entry.providerId != null);
    const [embedding] = await this.embedder.embed([body.slice(0, 8000)]);
    await this.pool.query(
      `INSERT INTO discussions (repo, pr_number, source, author, file_path, body, provider_id, platform_installation_id, created_at, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
       ${onConflict}`,
      [
        entry.repo,
        entry.prNumber ?? null,
        entry.source,
        entry.author,
        entry.filePath ?? null,
        body,
        entry.providerId ?? null,
        entry.platformInstallationId ?? null,
        entry.createdAt,
        toVectorLiteral(embedding!),
      ],
    );
    logger.debug(
      { repo: entry.repo, source: entry.source, providerId: entry.providerId },
      'stored discussion',
    );
  }

  async insertMany(entries: DiscussionEntry[]): Promise<number> {
    let stored = 0;
    for (const entry of entries) {
      await this.insert(entry);
      stored++;
    }
    return stored;
  }

  async search(
    repo: string,
    query: string,
    limit: number,
  ): Promise<DiscussionHit[]> {
    const [embedding] = await this.embedder.embed([query.slice(0, 8000)]);
    const { rows } = await this.pool.query<DiscussionRow>(
      `SELECT repo, pr_number, source, author, file_path, body, provider_id, platform_installation_id, created_at,
              1 - (embedding <=> $1::vector) AS score
       FROM discussions
       WHERE repo = $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [toVectorLiteral(embedding!), repo, limit],
    );
    return rows.map((row) => ({
      repo: row.repo,
      prNumber: row.pr_number ?? undefined,
      source: row.source,
      author: row.author,
      filePath: row.file_path ?? undefined,
      body: row.body,
      providerId: row.provider_id ?? undefined,
      platformInstallationId: row.platform_installation_id ?? undefined,
      createdAt: row.created_at,
      score: Number(row.score),
    }));
  }
}
