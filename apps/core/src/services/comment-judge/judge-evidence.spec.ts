import type {
  GitAdapterContract,
  PRMeta,
} from '@code-review-agent/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { buildJudgeThreads, excerptAround } from './judge-evidence.js';
import { COMMENT_SHA, HEAD_SHA, resolvedThread } from './judge-fixtures.js';

const META = { owner: 'acme', repo: 'payments' } as PRMeta;

const COMPARE_DIFF = [
  'diff --git a/src/refund.ts b/src/refund.ts',
  '--- a/src/refund.ts',
  '+++ b/src/refund.ts',
  '@@ -1,2 +1,3 @@',
  ' export const refund = (a) => {',
  '+  if (a < 0) throw new Error("negative");',
  '   return pay(a);',
].join('\n');

interface FakeGit {
  git: GitAdapterContract;
  getCompareDiff: ReturnType<typeof vi.fn>;
  getFileContent: ReturnType<typeof vi.fn>;
}

function fakeGit(
  overrides: Partial<Pick<FakeGit, 'getCompareDiff' | 'getFileContent'>> = {},
): FakeGit {
  const getCompareDiff =
    overrides.getCompareDiff ??
    vi.fn().mockResolvedValue({
      diff: COMPARE_DIFF,
      changedFiles: ['src/refund.ts', 'src/charge.ts'],
      status: 'ahead',
    });
  const getFileContent =
    overrides.getFileContent ??
    vi
      .fn()
      .mockResolvedValue(
        'export const refund = (a) => {\n  if (a < 0) throw new Error("negative");\n  return pay(a);',
      );
  const git = {
    getCompareDiff,
    getFileContent,
  } as unknown as GitAdapterContract;
  return { git, getCompareDiff, getFileContent };
}

describe('buildJudgeThreads', () => {
  it('gives the thread file diff since the comment, other changed files and the current code', async () => {
    const fake = fakeGit();

    const [thread] = await buildJudgeThreads(fake.git, META, HEAD_SHA, [
      resolvedThread(),
    ]);

    expect(fake.getCompareDiff).toHaveBeenCalledWith(
      'acme',
      'payments',
      COMMENT_SHA,
      HEAD_SHA,
    );
    expect(fake.getFileContent).toHaveBeenCalledWith(
      'acme',
      'payments',
      'src/refund.ts',
      HEAD_SHA,
    );
    expect(thread.changes).toMatchObject({
      status: 'changed',
      fromSha: COMMENT_SHA,
      toSha: HEAD_SHA,
    });
    expect(
      thread.changes.status === 'changed' && thread.changes.diff,
    ).toContain('L2 | +  if (a < 0) throw new Error("negative");');
    expect(thread.otherChangedFiles).toEqual(['src/charge.ts']);
    expect(thread.currentCode).toEqual({
      startLine: 1,
      lines: [
        'export const refund = (a) => {',
        '  if (a < 0) throw new Error("negative");',
        '  return pay(a);',
      ],
    });
    expect(thread.comments.map((comment) => comment.body)).toEqual([
      'Reject negative amounts.',
      'Fixed.',
    ]);
    expect(thread.diffHunk).toContain('pay(a)');
  });

  it('compares once per comment commit', async () => {
    const fake = fakeGit();

    await buildJudgeThreads(fake.git, META, HEAD_SHA, [
      resolvedThread(),
      resolvedThread({ id: 'T2', path: 'src/charge.ts' }),
    ]);

    expect(fake.getCompareDiff).toHaveBeenCalledTimes(1);
    expect(fake.getFileContent).toHaveBeenCalledTimes(2);
  });

  it('marks the diff unchanged or unavailable instead of failing', async () => {
    const unchanged = fakeGit({
      getCompareDiff: vi
        .fn()
        .mockResolvedValue({ diff: '', changedFiles: [], status: 'ahead' }),
    });
    const rewritten = fakeGit({
      getCompareDiff: vi
        .fn()
        .mockRejectedValue(new Error('No common ancestor')),
    });

    const [same] = await buildJudgeThreads(unchanged.git, META, HEAD_SHA, [
      resolvedThread(),
    ]);
    const [gone] = await buildJudgeThreads(rewritten.git, META, HEAD_SHA, [
      resolvedThread(),
    ]);

    expect(same.changes.status).toBe('unchanged');
    expect(gone.changes).toEqual({
      status: 'unavailable',
      reason: 'No common ancestor',
    });
  });

  it('reports a deleted file as having no current code', async () => {
    const deleted = fakeGit({
      getFileContent: vi.fn().mockResolvedValue(null),
    });

    const [thread] = await buildJudgeThreads(deleted.git, META, HEAD_SHA, [
      resolvedThread(),
    ]);

    expect(thread.currentCode).toBeNull();
  });
});

describe('excerptAround', () => {
  const content = Array.from(
    { length: 200 },
    (_, index) => `line ${index + 1}`,
  ).join('\n');

  it('shows 40 lines either side of the line, clamped to the file', () => {
    expect(excerptAround(content, 100)).toMatchObject({ startLine: 60 });
    expect(excerptAround(content, 100)?.lines).toHaveLength(81);
    expect(excerptAround(content, 2)).toMatchObject({ startLine: 1 });
    expect(excerptAround(content, 999)?.lines.at(-1)).toBe('line 200');
  });
});
