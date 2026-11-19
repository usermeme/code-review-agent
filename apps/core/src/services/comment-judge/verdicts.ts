import type { ThreadJudgment } from '@code-review-agent/review-agent';
import type {
  ReviewThread,
  ThreadJudgmentAction,
  ThreadJudgmentDoc,
  ThreadJudgmentRecord,
} from '@code-review-agent/shared-types';

import { JUDGE_REPLY_MARKER, SKIP_JUDGE_MARKER } from './thread-plan.js';

/** The `not_fixed` verdict that escalates a thread to a human for good. */
export const MAX_NOT_FIXED = 3;
const MAX_HISTORY = 10;

export interface JudgedThread {
  doc: ThreadJudgmentDoc;
  thread: ReviewThread;
  judgment: ThreadJudgment;
}

export interface VerdictOutcome {
  fields: Partial<ThreadJudgmentDoc>;
  action?: ThreadJudgmentAction;
  escalated: boolean;
}

export interface VerdictContext {
  headSha: string;
  model: string;
  judgedAt: Date;
}

function footer(failedChecks: number, headSha: string): string {
  return `<sub>Comment judge · failed check ${failedChecks} of ${MAX_NOT_FIXED} · \`${headSha.slice(0, 7)}\` · to keep a resolution without a check, reply with \`${SKIP_JUDGE_MARKER}\` and resolve again</sub>`;
}

export function formatReopenBody(
  reason: string,
  failedChecks: number,
  headSha: string,
): string {
  if (failedChecks >= MAX_NOT_FIXED) {
    return `${JUDGE_REPLY_MARKER}\n🔍 **Still not resolved:** ${reason}\n\nThe judge has now found this comment unresolved ${MAX_NOT_FIXED} times, so it stops here and leaves the thread to a human.\n\n${footer(failedChecks, headSha)}`;
  }
  return `${JUDGE_REPLY_MARKER}\n🔍 **Not resolved yet:** ${reason}\n\n${footer(failedChecks, headSha)}`;
}

/**
 * The original comment: a 👍 on it reads as "this concern was verified
 * resolved". The latest comment may be the judge's own earlier reply.
 */
function reactionTarget(thread: ReviewThread): string | undefined {
  return thread.comments[0]?.id;
}

function confirmAction(thread: ReviewThread): ThreadJudgmentAction | undefined {
  const commentId = reactionTarget(thread);
  return commentId
    ? { type: 'react', threadId: thread.id, commentId }
    : undefined;
}

function baseFields(
  item: JudgedThread,
  context: VerdictContext,
): Pick<ThreadJudgmentDoc, 'lastVerdict' | 'history'> {
  const record: ThreadJudgmentRecord = {
    verdict: item.judgment.verdict,
    headSha: context.headSha,
    judgedAt: context.judgedAt,
  };
  return {
    lastVerdict: {
      ...record,
      reason: item.judgment.reason,
      model: context.model,
    },
    history: [...(item.doc.history ?? []), record].slice(-MAX_HISTORY),
  };
}

function notFixedOutcome(
  item: JudgedThread,
  context: VerdictContext,
): VerdictOutcome {
  const notFixedCount = (item.doc.notFixedCount ?? 0) + 1;
  const escalated = notFixedCount >= MAX_NOT_FIXED;
  return {
    fields: {
      ...baseFields(item, context),
      status: escalated ? 'escalated' : 'not_fixed',
      notFixedCount,
    },
    action: {
      type: 'reopen',
      threadId: item.thread.id,
      body: formatReopenBody(
        item.judgment.reason,
        notFixedCount,
        context.headSha,
      ),
    },
    escalated,
  };
}

/**
 * `not_fixed` re-opens the thread with the reason (escalating on the third
 * time); `fixed` and `accepted` confirm the resolution with a reaction.
 */
export function applyVerdict(
  item: JudgedThread,
  context: VerdictContext,
): VerdictOutcome {
  if (item.judgment.verdict === 'not_fixed')
    return notFixedOutcome(item, context);
  return {
    fields: { ...baseFields(item, context), status: item.judgment.verdict },
    action: confirmAction(item.thread),
    escalated: false,
  };
}
