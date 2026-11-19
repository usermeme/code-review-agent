import type {
  ReviewThread,
  ThreadJudgmentDoc,
} from '@code-review-agent/shared-types';

/** In the latest reply, keeps a resolution as it is without a check. */
export const SKIP_JUDGE_MARKER = '[skip judge]';

/**
 * Hidden marker on every reply the judge posts. Its footer mentions
 * `[skip judge]`, so the judge's own replies must not count as an opt-out.
 */
export const JUDGE_REPLY_MARKER = '<!-- comment-judge -->';

export type ThreadPlan =
  | { kind: 'judge'; doc: ThreadJudgmentDoc; thread: ReviewThread }
  | { kind: 'pending'; doc: ThreadJudgmentDoc }
  | { kind: 'skip'; doc: ThreadJudgmentDoc; reason: string };

/** Docs waiting for a verdict: just resolved, or waiting for a push. */
export function isAwaitingJudgment(doc: ThreadJudgmentDoc): boolean {
  return doc.status === 'queued' || doc.status === 'pending';
}

function isJudgeReply(body: string): boolean {
  return body.includes(JUDGE_REPLY_MARKER);
}

/** The latest reply not written by the judge carries the opt-out. */
function hasSkipMarker(thread: ReviewThread): boolean {
  const replies = thread.comments.filter(
    (comment) => !isJudgeReply(comment.body),
  );
  const latest = replies[replies.length - 1];
  return Boolean(latest?.body.toLowerCase().includes(SKIP_JUDGE_MARKER));
}

/** True when nothing was pushed after the comment was written. */
function hasNoCommitSinceComment(
  thread: ReviewThread,
  headSha: string,
): boolean {
  return thread.comments[0]?.originalCommitSha === headSha;
}

/**
 * What to do with an awaiting thread at `headSha`. Deliberately ignores who
 * wrote or resolved anything: only the thread's state and content count.
 */
export function planThread(
  doc: ThreadJudgmentDoc,
  thread: ReviewThread | undefined,
  headSha: string,
): ThreadPlan {
  if (!thread)
    return { kind: 'skip', doc, reason: 'The thread no longer exists.' };
  if (!thread.isResolved) {
    return { kind: 'skip', doc, reason: 'Re-opened before it was judged.' };
  }
  if (hasSkipMarker(thread)) {
    return { kind: 'skip', doc, reason: `Resolved with ${SKIP_JUDGE_MARKER}.` };
  }
  // A fix that is not pushed yet must not be judged against the old code.
  if (hasNoCommitSinceComment(thread, headSha)) return { kind: 'pending', doc };
  return { kind: 'judge', doc, thread };
}
