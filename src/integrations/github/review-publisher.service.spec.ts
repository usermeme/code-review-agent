import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from 'octokit';
import { anchorableLines, GithubReviewPublisher } from './review-publisher.service.js';

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

describe('anchorableLines', () => {
  it('collects new-side line numbers from hunks', () => {
    const lines = anchorableLines(PATCH);
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 12, 13, 14]);
  });
});

function fakeOctokit(createReview: ReturnType<typeof vi.fn>): Octokit {
  return {
    rest: {
      pulls: {
        createReview,
        get: vi.fn().mockResolvedValue({ data: { head: { sha: 'abc' } } }),
        listFiles: vi.fn(),
      },
    },
    paginate: vi.fn().mockResolvedValue([
      { filename: 'src/a.ts', patch: PATCH },
    ]),
  } as unknown as Octokit;
}

describe('GithubReviewPublisher', () => {
  it('republishes with all findings in the summary when inline comments are rejected (422)', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Unprocessable Entity'), { status: 422 }))
      .mockResolvedValueOnce({});
      
    const publisher = new GithubReviewPublisher(fakeOctokit(createReview));
    await publisher.publishReview(
      { provider: 'github', owner: 'o', name: 'r' },
      1,
      [{ path: 'src/a.ts', line: 3, body: 'inline finding' }],
      'summary'
    );
    
    expect(createReview).toHaveBeenCalledTimes(2);
    expect((createReview.mock.calls[0]![0] as { comments?: unknown[] }).comments).toHaveLength(1);
    const retry = createReview.mock.calls[1]![0] as { comments?: unknown[], body: string };
    expect(retry.comments).toBeUndefined();
    expect(retry.body).toContain('inline finding');
  });

  it('rethrows non-422 errors without retrying', async () => {
    const createReview = vi.fn().mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
    const publisher = new GithubReviewPublisher(fakeOctokit(createReview));
    
    await expect(
      publisher.publishReview(
        { provider: 'github', owner: 'o', name: 'r' },
        1,
        [],
        'summary'
      )
    ).rejects.toThrow('server error');
    
    expect(createReview).toHaveBeenCalledTimes(1);
  });
});
