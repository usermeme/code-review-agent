import type { ReviewThread } from '@code-review-agent/shared-types';

/** Threads per GraphQL page (GitHub's maximum). */
const THREADS_PAGE_SIZE = 100;
/** Pages fetched at most (500 threads); older threads beyond that are ignored. */
const MAX_THREAD_PAGES = 5;
/** Comments read per thread: the opening comment and the latest replies. */
const COMMENTS_PER_THREAD = 10;

export const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: ${THREADS_PAGE_SIZE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            path
            line
            isResolved
            isOutdated
            comments(first: ${COMMENTS_PER_THREAD}) {
              nodes { body author { login } }
            }
          }
        }
      }
    }
  }
`;

interface ThreadNode {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: {
    nodes: Array<{ body: string; author: { login: string } | null }>;
  };
}

export interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ThreadNode[];
      };
    } | null;
  } | null;
}

export type GraphqlClient = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<ReviewThreadsResponse>;

function toReviewThread(node: ThreadNode): ReviewThread {
  return {
    id: node.id,
    path: node.path,
    line: node.line,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    comments: node.comments.nodes.map((comment) => ({
      // Deleted accounts come back as a null author ("ghost" on github.com).
      author: comment.author?.login ?? 'ghost',
      body: comment.body,
    })),
  };
}

interface ThreadPage {
  threads: ReviewThread[];
  /** Cursor of the next page, or null on the last page. */
  nextCursor: string | null;
}

function readPage(response: ReviewThreadsResponse): ThreadPage {
  const connection = response.repository?.pullRequest?.reviewThreads;
  if (!connection) return { threads: [], nextCursor: null };
  const { hasNextPage, endCursor } = connection.pageInfo;
  return {
    threads: connection.nodes.map(toReviewThread),
    nextCursor: hasNextPage ? endCursor : null,
  };
}

/** Reads every inline review thread on a PR, following GraphQL pagination. */
export async function fetchReviewThreads(
  graphql: GraphqlClient,
  variables: { owner: string; repo: string; number: number },
): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const result = readPage(
      await graphql(REVIEW_THREADS_QUERY, { ...variables, cursor }),
    );
    threads.push(...result.threads);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return threads;
}
