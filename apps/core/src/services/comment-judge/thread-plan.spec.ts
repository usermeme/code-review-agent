import { describe, expect, it } from 'vitest';

import {
  COMMENT_SHA,
  HEAD_SHA,
  judgmentDoc,
  resolvedThread,
} from './judge-fixtures.js';
import { isAwaitingJudgment, planThread } from './thread-plan.js';
import { formatReopenBody } from './verdicts.js';

describe('planThread', () => {
  const doc = judgmentDoc();

  it('judges a resolved thread with a commit after the comment', () => {
    expect(planThread(doc, resolvedThread(), HEAD_SHA).kind).toBe('judge');
  });

  it('waits for a push when nothing was committed after the comment', () => {
    expect(planThread(doc, resolvedThread(), COMMENT_SHA)).toEqual({
      kind: 'pending',
      doc,
    });
  });

  it('skips a thread resolved with [skip judge] in its latest reply, in any case', () => {
    const thread = resolvedThread();
    thread.comments[1].body = 'Intentional, see ADR-7. [Skip Judge]';

    expect(planThread(doc, thread, HEAD_SHA)).toMatchObject({
      kind: 'skip',
      reason: 'Resolved with [skip judge].',
    });
  });

  it("ignores the [skip judge] mention in the judge's own earlier reply", () => {
    const thread = resolvedThread();
    thread.comments[1].body = formatReopenBody('Still broken.', 1, HEAD_SHA);

    expect(thread.comments[1].body).toContain('[skip judge]');
    expect(planThread(doc, thread, HEAD_SHA).kind).toBe('judge');
  });

  it('skips threads that were re-opened or deleted before judging', () => {
    expect(
      planThread(doc, resolvedThread({ isResolved: false }), HEAD_SHA),
    ).toMatchObject({
      kind: 'skip',
      reason: 'Re-opened before it was judged.',
    });
    expect(planThread(doc, undefined, HEAD_SHA)).toMatchObject({
      kind: 'skip',
      reason: 'The thread no longer exists.',
    });
  });

  it('does not care who resolved the thread', () => {
    const byOpener = resolvedThread({ resolvedBy: 'alice' });
    const byBot = resolvedThread({ resolvedBy: 'fixer[bot]' });

    expect(planThread(doc, byOpener, HEAD_SHA).kind).toBe('judge');
    expect(planThread(doc, byBot, HEAD_SHA).kind).toBe('judge');
  });
});

describe('isAwaitingJudgment', () => {
  it.each([
    ['queued', true],
    ['pending', true],
    ['fixed', false],
    ['not_fixed', false],
    ['escalated', false],
    ['skipped', false],
  ] as const)('%s → %s', (status, expected) => {
    expect(isAwaitingJudgment(judgmentDoc({ status }))).toBe(expected);
  });
});
