import { RepoWorkspace } from '@code-review-agent/agent-tools';
import type { PRMeta } from '@code-review-agent/shared-types';
import { describe, expect, it, vi } from 'vitest';

import {
  createFunctionCallResponse,
  createTextResponse,
  ScriptedLlm,
} from '../testing/scripted-llm.js';
import type { JudgeThread } from './judge-input.js';
import { buildJudgePrompt, JUDGE_INSTRUCTION } from './judge-prompt.js';
import { runCommentJudge } from './run-comment-judge.js';

const META: PRMeta = {
  provider: 'github',
  owner: 'acme',
  repo: 'payments',
  prNumber: 9,
  title: 'fix: refunds',
  author: 'alice',
  branch: 'fix/refunds',
  htmlUrl: 'https://github.com/acme/payments/pull/9',
  action: 'thread_resolved',
  headSha: 'head-sha-1234567',
};

function thread(overrides: Partial<JudgeThread> = {}): JudgeThread {
  return {
    threadId: 'T1',
    path: 'src/refund.ts',
    line: 12,
    originalLine: 10,
    comments: [
      {
        author: 'alice',
        body: 'Reject negative amounts here.',
        createdAt: '2026-11-18T10:00:00Z',
      },
      { author: 'alice', body: 'Fixed in the next commit.' },
    ],
    diffHunk:
      '@@ -8,3 +8,4 @@\n+export const refund = (amount) => pay(amount);',
    changes: {
      status: 'changed',
      fromSha: 'comment-sha-999',
      toSha: 'head-sha-1234567',
      diff: 'L12 | +  if (amount < 0) throw new Error("negative");',
      truncated: false,
    },
    otherChangedFiles: ['src/charge.ts'],
    currentCode: {
      startLine: 11,
      lines: [
        'export const refund = (amount) => {',
        '  if (amount < 0) throw new Error("negative");',
      ],
    },
    ...overrides,
  };
}

const loadWorkspace = async () =>
  new RepoWorkspace({ files: new Map(), rawDiff: '', changedFiles: [] });

describe('buildJudgePrompt', () => {
  it('shows the comments, the diff since the comment and the current code', () => {
    const prompt = buildJudgePrompt('fix: refunds', 9, [thread()]);

    expect(prompt).toContain('## Thread 0: `src/refund.ts` (line 12)');
    expect(prompt).toContain(
      '**alice** (2026-11-18T10:00:00Z):\nReject negative amounts here.',
    );
    expect(prompt).toContain('since the comment (comment → head-sh)');
    expect(prompt).toContain('L12 | +  if (amount < 0)');
    expect(prompt).toContain('- `src/charge.ts`');
    expect(prompt).toContain('(lines 11-12)');
    expect(prompt).toContain('12 |   if (amount < 0)');
  });

  it('says so when the file did not change, the diff is unavailable or the file is gone', () => {
    const prompt = buildJudgePrompt('t', 1, [
      thread({
        changes: {
          status: 'unchanged',
          fromSha: 'aaaaaaa1',
          toSha: 'bbbbbbb2',
        },
      }),
      thread({
        line: null,
        changes: { status: 'unavailable', reason: 'commit not found' },
        currentCode: null,
      }),
    ]);

    expect(prompt).toContain('This file has not changed since the comment.');
    expect(prompt).toContain('Unavailable: commit not found');
    expect(prompt).toContain('originally line 10, now outdated');
    expect(prompt).toContain('The file no longer exists at the head.');
  });

  it('tells the model to judge content, not authors, and to raise nothing new', () => {
    expect(JUDGE_INSTRUCTION).toContain('never by who wrote them');
    expect(JUDGE_INSTRUCTION).toContain('Never raise new or unrelated issues');
  });
});

describe('runCommentJudge', () => {
  it('returns the verdicts by thread id and drops unknown thread numbers', async () => {
    const llm = new ScriptedLlm([
      () =>
        createFunctionCallResponse('submit_judgments', {
          judgments: [
            {
              thread: 0,
              verdict: 'fixed',
              reason: 'Negative amounts now throw.',
            },
            {
              thread: 1,
              verdict: 'not_fixed',
              reason: 'Still unchecked at src/b.ts:4.',
            },
            { thread: 7, verdict: 'fixed', reason: 'No such thread.' },
          ],
        }),
    ]);

    const result = await runCommentJudge(
      {
        prMeta: META,
        threads: [thread(), thread({ threadId: 'T2' })],
        loadWorkspace,
      },
      { model: llm, timeoutMs: 10_000, maxLlmCalls: 4 },
    );

    expect([...result.judgments.entries()]).toEqual([
      ['T1', { verdict: 'fixed', reason: 'Negative amounts now throw.' }],
      [
        'T2',
        { verdict: 'not_fixed', reason: 'Still unchecked at src/b.ts:4.' },
      ],
    ]);
    expect(result.error).toBeUndefined();
    expect(result.repoLoaded).toBe(false);
    expect(JSON.stringify(llm.requests[0].contents)).toContain('Thread 1');
  });

  it('downloads the repository only when the model calls a tool', async () => {
    const load = vi.fn(loadWorkspace);
    const llm = new ScriptedLlm([
      () => createFunctionCallResponse('find_files', { pattern: '**/*.ts' }),
      () =>
        createFunctionCallResponse('submit_judgments', {
          judgments: [{ thread: 0, verdict: 'fixed', reason: 'Done.' }],
        }),
    ]);

    const result = await runCommentJudge(
      { prMeta: META, threads: [thread()], loadWorkspace: load },
      { model: llm, timeoutMs: 10_000, maxLlmCalls: 4 },
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(result.repoLoaded).toBe(true);
    expect(result.judgments.get('T1')?.verdict).toBe('fixed');
  });

  it('reports an error and no verdicts when the model never submits', async () => {
    const llm = new ScriptedLlm([
      () => createTextResponse('Looks fine to me.'),
    ]);

    const result = await runCommentJudge(
      { prMeta: META, threads: [thread()], loadWorkspace },
      { model: llm, timeoutMs: 10_000, maxLlmCalls: 2 },
    );

    expect(result.judgments.size).toBe(0);
    expect(result.error).toBe(
      'Comment judge finished without calling submit_judgments.',
    );
  });
});
