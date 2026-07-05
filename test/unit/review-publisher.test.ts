import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from 'octokit';
import { anchorableLines, publishReview, splitFindings } from '../../src/github/review-publisher.js';
import type { Finding, ReviewPlan } from '../../src/agents/schemas.js';

const PATCH = [
  '@@ -1,4 +1,6 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' console.log(a);',
  '@@ -10,2 +12,3 @@',
  ' function f() {',
  '+  return b + c;',
  ' }',
].join('\n');

function finding(overrides: Partial<Finding>): Finding {
  return {
    title: 't',
    severity: 'major',
    path: 'src/a.ts',
    startLine: 2,
    endLine: 2,
    body: 'b',
    confidence: 0.9,
    ...overrides,
  };
}

describe('anchorableLines', () => {
  it('collects new-side line numbers from hunks', () => {
    const lines = anchorableLines(PATCH);
    // First hunk: new lines 1 (' '), 2 ('+'), 3 ('+'), 4 (' ') — old-side deletion skipped.
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 12, 13, 14]);
  });
});

describe('splitFindings', () => {
  const files = [{ filename: 'src/a.ts', status: 'modified', patch: PATCH, additions: 3, deletions: 1 }];

  it('anchors findings on diff lines and supports multi-line ranges', () => {
    const { comments, unanchored } = splitFindings([finding({ startLine: 2, endLine: 3 })], files);
    expect(unanchored).toHaveLength(0);
    expect(comments[0]).toMatchObject({ path: 'src/a.ts', line: 3, start_line: 2, side: 'RIGHT' });
  });

  it('falls back to summary for lines outside hunks or unknown files', () => {
    const { comments, unanchored } = splitFindings(
      [finding({ endLine: 99 }), finding({ path: 'src/missing.ts' })],
      files,
    );
    expect(comments).toHaveLength(0);
    expect(unanchored).toHaveLength(2);
  });

  it('renders suggestions as suggestion blocks', () => {
    const { comments } = splitFindings([finding({ suggestion: 'const b = 5;' })], files);
    expect(comments[0]!.body).toContain('```suggestion\nconst b = 5;\n```');
  });

  it('demotes a range spanning hunks to a single-line comment on the last line', () => {
    // Lines 4 (first hunk) → 12 (second hunk): 5-11 are not anchorable, and
    // GitHub would reject the whole review over such a range.
    const { comments, unanchored } = splitFindings([finding({ startLine: 4, endLine: 12 })], files);
    expect(unanchored).toHaveLength(0);
    expect(comments[0]).toMatchObject({ line: 12 });
    expect(comments[0]).not.toHaveProperty('start_line');
  });
});

describe('publishReview', () => {
  const plan: ReviewPlan = {
    summary: 'overall verdict',
    findings: [finding({ title: 'inline finding', startLine: 2, endLine: 2 })],
  };
  const files = [{ filename: 'src/a.ts', status: 'modified', patch: PATCH, additions: 3, deletions: 1 }];

  function fakeOctokit(createReview: ReturnType<typeof vi.fn>): Octokit {
    return { rest: { pulls: { createReview } } } as unknown as Octokit;
  }

  it('republishes with all findings in the summary when inline comments are rejected (422)', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Unprocessable Entity'), { status: 422 }))
      .mockResolvedValueOnce({});
    await publishReview({
      octokit: fakeOctokit(createReview),
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      headSha: 'abc',
      plan,
      files,
    });
    expect(createReview).toHaveBeenCalledTimes(2);
    expect(createReview.mock.calls[0]![0].comments).toHaveLength(1);
    const retry = createReview.mock.calls[1]![0];
    expect(retry.comments).toBeUndefined();
    expect(retry.body).toContain('inline finding');
  });

  it('rethrows non-422 errors without retrying', async () => {
    const createReview = vi.fn().mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
    await expect(
      publishReview({
        octokit: fakeOctokit(createReview),
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: 'abc',
        plan,
        files,
      }),
    ).rejects.toThrow('server error');
    expect(createReview).toHaveBeenCalledTimes(1);
  });
});
