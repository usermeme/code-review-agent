import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryDatabaseService } from '../testing/in-memory-database.service.js';
import { DiscussionRepository } from './discussion.repository.js';

function note(
  overrides: Partial<Parameters<DiscussionRepository['store']>[0]> = {},
) {
  return {
    repo: 'acme/app',
    prNumber: 7,
    source: 'bot_finding',
    author: 'code-review-agent',
    body: 'note',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('DiscussionRepository', () => {
  let db: InMemoryDatabaseService;
  let repo: DiscussionRepository;

  beforeEach(() => {
    db = new InMemoryDatabaseService();
    repo = new DiscussionRepository(db);
  });

  it('stores entries under a slash-free document id', async () => {
    await expect(repo.store(note())).resolves.toBe(true);
    const docIds = [
      ...(db.collections.get('review_discussions')?.keys() ?? []),
    ];
    expect(docIds).toHaveLength(1);
    expect(docIds[0]).not.toContain('/');
    expect(docIds[0]).toContain('acme:app:7');
  });

  it('ranks search results by token overlap and filters by repo', async () => {
    await repo.store(
      note({ body: 'SQL query built via string concatenation is unsafe here' }),
    );
    await repo.store(note({ body: 'all good, ship it' }));
    await repo.store(
      note({ repo: 'other/app', body: 'query concatenation elsewhere' }),
    );

    const hits = await repo.search('acme/app', 'unsafe concatenation', 5);

    expect(hits).toHaveLength(1);
    expect(hits[0].body).toContain('concatenation');
    expect(hits[0].score).toBe(1);
  });

  it('orders stronger matches first and respects the limit', async () => {
    await repo.store(note({ body: 'query concatenation details' }));
    await repo.store(note({ body: 'only mentions concatenation' }));
    await repo.store(note({ body: 'unrelated note' }));

    const hits = await repo.search('acme/app', 'query concatenation', 1);

    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBe(1);
  });

  it('returns nothing when the query has no usable tokens', async () => {
    await repo.store(note({ body: 'something about concatenation' }));
    await expect(repo.search('acme/app', 'a b c', 5)).resolves.toEqual([]);
  });

  it('maps stored fields onto discussion hits', async () => {
    await repo.store(
      note({ filePath: 'src/db.ts', body: 'concatenation risk', prNumber: 9 }),
    );

    const hits = await repo.search('acme/app', 'concatenation', 5);

    expect(hits[0]).toEqual(
      expect.objectContaining({
        author: 'code-review-agent',
        source: 'bot_finding',
        prNumber: 9,
        filePath: 'src/db.ts',
      }),
    );
  });
});
