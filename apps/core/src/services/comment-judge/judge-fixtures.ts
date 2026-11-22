import type {
  ReviewThread,
  ThreadJudgmentDoc,
} from '@code-review-agent/shared-types';

/** Test fixtures shared by the comment-judge specs. */
export const PR_KEY = 'github:acme:payments:9';
export const HEAD_SHA = 'head-sha-2222222';
export const COMMENT_SHA = 'comment-sha-1111111';

export function judgmentDoc(
  overrides: Partial<ThreadJudgmentDoc> = {},
): ThreadJudgmentDoc {
  return {
    provider: 'github',
    owner: 'acme',
    repo: 'payments',
    prNumber: 9,
    prKey: PR_KEY,
    threadId: 'T1',
    status: 'queued',
    queuedAtMs: 1_000,
    notFixedCount: 0,
    history: [],
    updatedAt: new Date(0),
    ...overrides,
  };
}

export function resolvedThread(
  overrides: Partial<ReviewThread> = {},
): ReviewThread {
  return {
    id: 'T1',
    path: 'src/refund.ts',
    line: 3,
    originalLine: 2,
    isResolved: true,
    isOutdated: false,
    resolvedBy: 'alice',
    comments: [
      {
        id: 'C1',
        author: 'alice',
        body: 'Reject negative amounts.',
        createdAt: '2026-11-18T10:00:00Z',
        originalCommitSha: COMMENT_SHA,
        diffHunk: '@@ -1,2 +1,2 @@\n+export const refund = (a) => pay(a);',
      },
      {
        id: 'C2',
        author: 'alice',
        body: 'Fixed.',
        createdAt: '2026-11-18T11:00:00Z',
        originalCommitSha: COMMENT_SHA,
      },
    ],
    ...overrides,
  };
}
