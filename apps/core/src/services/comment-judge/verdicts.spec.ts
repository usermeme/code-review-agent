import { describe, expect, it } from 'vitest';

import { HEAD_SHA, judgmentDoc, resolvedThread } from './judge-fixtures.js';
import { applyVerdict, MAX_NOT_FIXED } from './verdicts.js';

const CONTEXT = {
  headSha: HEAD_SHA,
  model: 'smart-model',
  judgedAt: new Date('2026-11-20T09:00:00Z'),
};

describe('applyVerdict', () => {
  it('re-opens a not-fixed thread with the reason and counts the failed check', () => {
    const outcome = applyVerdict(
      {
        doc: judgmentDoc(),
        thread: resolvedThread(),
        judgment: {
          verdict: 'not_fixed',
          reason: 'Still unchecked at src/refund.ts:3.',
        },
      },
      CONTEXT,
    );

    expect(outcome.escalated).toBe(false);
    expect(outcome.fields).toMatchObject({
      status: 'not_fixed',
      notFixedCount: 1,
    });
    expect(outcome.action).toMatchObject({ type: 'reopen', threadId: 'T1' });
    const body = outcome.action?.type === 'reopen' ? outcome.action.body : '';
    expect(body).toContain(
      '**Not resolved yet:** Still unchecked at src/refund.ts:3.',
    );
    expect(body).toContain(`failed check 1 of ${MAX_NOT_FIXED}`);
    expect(body).toContain('`head-sh`');
    expect(body).toContain('[skip judge]');
  });

  it('escalates on the third failed check', () => {
    const outcome = applyVerdict(
      {
        doc: judgmentDoc({ notFixedCount: MAX_NOT_FIXED - 1 }),
        thread: resolvedThread(),
        judgment: { verdict: 'not_fixed', reason: 'Still unchecked.' },
      },
      CONTEXT,
    );

    expect(outcome.escalated).toBe(true);
    expect(outcome.fields.status).toBe('escalated');
    const body = outcome.action?.type === 'reopen' ? outcome.action.body : '';
    expect(body).toContain('leaves the thread to a human');
  });

  it.each(['fixed', 'accepted'] as const)(
    'confirms a %s resolution with a reaction on the original comment',
    (verdict) => {
      const outcome = applyVerdict(
        {
          doc: judgmentDoc(),
          thread: resolvedThread(),
          judgment: { verdict, reason: 'ok' },
        },
        CONTEXT,
      );

      expect(outcome.fields.status).toBe(verdict);
      expect(outcome.action).toEqual({
        type: 'react',
        threadId: 'T1',
        commentId: 'C1',
      });
    },
  );

  it('records the verdict and keeps only the newest 10 history entries', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      verdict: 'not_fixed' as const,
      headSha: `sha-${index}`,
      judgedAt: new Date(index),
    }));

    const outcome = applyVerdict(
      {
        doc: judgmentDoc({ history }),
        thread: resolvedThread(),
        judgment: { verdict: 'fixed', reason: 'Done.' },
      },
      CONTEXT,
    );

    expect(outcome.fields.history).toHaveLength(10);
    expect(outcome.fields.history?.[0].headSha).toBe('sha-1');
    expect(outcome.fields.lastVerdict).toEqual({
      verdict: 'fixed',
      reason: 'Done.',
      headSha: HEAD_SHA,
      model: 'smart-model',
      judgedAt: CONTEXT.judgedAt,
    });
  });
});
