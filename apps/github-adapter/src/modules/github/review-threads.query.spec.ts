import { describe, expect, it, vi } from 'vitest';

import {
  fetchReviewThreads,
  type GraphqlClient,
  type ReviewThreadsResponse,
} from './review-threads.query.js';

function page(
  nodes: unknown[],
  hasNextPage: boolean,
  endCursor: string | null = null,
): ReviewThreadsResponse {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage, endCursor },
          nodes: nodes as never[],
        },
      },
    },
  };
}

const OPENER = {
  id: 'C1',
  body: 'This can be null.',
  createdAt: '2026-11-18T10:00:00Z',
  diffHunk: '@@ -1,2 +1,3 @@\n+const a = maybe();',
  originalCommit: { oid: 'sha-comment' },
  author: { login: 'other-bot[bot]' },
};

const REPLY = {
  id: 'C2',
  body: 'Intended, see ADR-7.',
  createdAt: '2026-11-18T11:00:00Z',
  originalCommit: { oid: 'sha-comment' },
  author: null,
};

const NODE = {
  id: 'T1',
  path: 'src/a.ts',
  line: null,
  originalLine: 3,
  isResolved: true,
  isOutdated: true,
  resolvedBy: { login: 'alice' },
  opener: { nodes: [OPENER] },
  // `last: 9` also returns the opener when the thread is short.
  latest: { nodes: [OPENER, REPLY] },
};

describe('fetchReviewThreads', () => {
  it('follows pagination and maps threads, using "ghost" for deleted authors', async () => {
    const graphql = vi
      .fn<GraphqlClient>()
      .mockResolvedValueOnce(page([NODE], true, 'cursor-1'))
      .mockResolvedValueOnce(page([{ ...NODE, id: 'T2' }], false));

    const threads = await fetchReviewThreads(graphql, {
      owner: 'acme',
      repo: 'payments',
      number: 7,
    });

    expect(threads.map((t) => t.id)).toEqual(['T1', 'T2']);
    expect(threads[0]).toEqual({
      id: 'T1',
      path: 'src/a.ts',
      line: null,
      originalLine: 3,
      isResolved: true,
      isOutdated: true,
      resolvedBy: 'alice',
      comments: [
        {
          author: 'other-bot[bot]',
          body: 'This can be null.',
          id: 'C1',
          createdAt: '2026-11-18T10:00:00Z',
          originalCommitSha: 'sha-comment',
          diffHunk: '@@ -1,2 +1,3 @@\n+const a = maybe();',
        },
        {
          author: 'ghost',
          body: 'Intended, see ADR-7.',
          id: 'C2',
          createdAt: '2026-11-18T11:00:00Z',
          originalCommitSha: 'sha-comment',
        },
      ],
    });
    expect(graphql.mock.calls[1][1]).toMatchObject({ cursor: 'cursor-1' });
  });

  it('returns no threads when the PR is not found', async () => {
    const graphql = vi
      .fn<GraphqlClient>()
      .mockResolvedValue({ repository: { pullRequest: null } });

    await expect(
      fetchReviewThreads(graphql, { owner: 'a', repo: 'b', number: 1 }),
    ).resolves.toEqual([]);
  });
});
