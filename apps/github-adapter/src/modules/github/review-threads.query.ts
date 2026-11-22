import type {
  ReviewThread,
  ReviewThreadComment,
} from '@code-review-agent/shared-types';

/** Threads per GraphQL page (GitHub's maximum). */
const THREADS_PAGE_SIZE = 100;
/** Pages fetched at most (500 threads); older threads beyond that are ignored. */
const MAX_THREAD_PAGES = 5;
/** Latest replies read per thread, next to the opening comment. */
const LATEST_COMMENTS_PER_THREAD = 9;

const COMMENT_FIELDS = `
  id
  body
  createdAt
  diffHunk
  originalCommit { oid }
  author { login }
`;

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
            originalLine
            isResolved
            isOutdated
            resolvedBy { login }
            opener: comments(first: 1) { nodes { ${COMMENT_FIELDS} } }
            latest: comments(last: ${LATEST_COMMENTS_PER_THREAD}) { nodes { ${COMMENT_FIELDS} } }
          }
        }
      }
    }
  }
`;

interface CommentNode {
  id: string;
  body: string;
  createdAt?: string;
  diffHunk?: string;
  originalCommit?: { oid: string } | null;
  author: { login: string } | null;
}

interface ThreadNode {
  id: string;
  path: string;
  line: number | null;
  originalLine?: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy?: { login: string } | null;
  opener: { nodes: CommentNode[] };
  latest: { nodes: CommentNode[] };
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

/** Optional comment fields, left out when GitHub returned none. */
function commentDetails(
  node: CommentNode,
): Pick<ReviewThreadComment, 'createdAt' | 'diffHunk' | 'originalCommitSha'> {
  const originalCommitSha = node.originalCommit?.oid;
  return {
    ...(node.createdAt ? { createdAt: node.createdAt } : {}),
    ...(originalCommitSha ? { originalCommitSha } : {}),
    ...(node.diffHunk ? { diffHunk: node.diffHunk } : {}),
  };
}

function toComment(node: CommentNode): ReviewThreadComment {
  return {
    // Deleted accounts come back as a null author ("ghost" on github.com).
    author: node.author?.login ?? 'ghost',
    body: node.body,
    id: node.id,
    ...commentDetails(node),
  };
}

/** The opening comment, then the latest replies, each comment once. */
function mergeComments(node: ThreadNode): ReviewThreadComment[] {
  const seen = new Set<string>();
  const merged: ReviewThreadComment[] = [];
  for (const comment of [...node.opener.nodes, ...node.latest.nodes]) {
    if (!seen.has(comment.id)) {
      seen.add(comment.id);
      merged.push(toComment(comment));
    }
  }
  return merged;
}

function toReviewThread(node: ThreadNode): ReviewThread {
  return {
    id: node.id,
    path: node.path,
    line: node.line,
    originalLine: node.originalLine ?? null,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    resolvedBy: node.resolvedBy?.login ?? null,
    comments: mergeComments(node),
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
