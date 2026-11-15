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

const NODE = {
  id: 'T1',
  path: 'src/a.ts',
  line: null,
  isResolved: true,
  isOutdated: true,
  comments: {
    nodes: [
      { body: 'This can be null.', author: { login: 'other-bot[bot]' } },
      { body: 'Intended, see ADR-7.', author: null },
    ],
  },
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
      isResolved: true,
      isOutdated: true,
      comments: [
        { author: 'other-bot[bot]', body: 'This can be null.' },
        { author: 'ghost', body: 'Intended, see ADR-7.' },
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
