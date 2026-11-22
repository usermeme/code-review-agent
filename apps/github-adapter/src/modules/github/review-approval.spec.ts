import type { Octokit } from 'octokit';
import { describe, expect, it, vi } from 'vitest';

import {
  decideReviewEvent,
  DISMISS_MESSAGE,
  dismissOwnApprovals,
} from './review-approval.js';

const PR = { owner: 'acme', repo: 'payments', prNumber: 7 };
const SHA = 'abc123';

function threadsResponse(resolved: boolean[]) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: resolved.map((isResolved, i) => ({
            id: `T${i}`,
            path: 'src/a.ts',
            line: 1,
            isResolved,
            isOutdated: false,
            opener: { nodes: [] },
            latest: { nodes: [] },
          })),
        },
      },
    },
  };
}

function octokitWithThreads(resolved: boolean[]) {
  const graphql = vi.fn().mockResolvedValue(threadsResponse(resolved));
  return { octokit: { graphql } as unknown as Octokit, graphql };
}

describe('decideReviewEvent', () => {
  it('comments without a note when core did not ask for approval', async () => {
    const { octokit, graphql } = octokitWithThreads([]);

    const decision = await decideReviewEvent(octokit, PR, SHA);

    expect(decision).toEqual({ event: 'COMMENT', note: '' });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('approves a clean review of the current head with no open threads', async () => {
    const { octokit } = octokitWithThreads([true, true]);

    const decision = await decideReviewEvent(
      octokit,
      { ...PR, approve: true, reviewedSha: SHA },
      SHA,
    );

    expect(decision).toEqual({ event: 'APPROVE', note: '' });
  });

  it('does not approve when new commits arrived after the review', async () => {
    const { octokit, graphql } = octokitWithThreads([]);

    const decision = await decideReviewEvent(
      octokit,
      { ...PR, approve: true, reviewedSha: SHA },
      'def456',
    );

    expect(decision.event).toBe('COMMENT');
    expect(decision.note).toContain('new commits were pushed');
    expect(graphql).not.toHaveBeenCalled();
  });

  it('does not approve when the PR head is unknown', async () => {
    const { octokit } = octokitWithThreads([]);

    const decision = await decideReviewEvent(
      octokit,
      { ...PR, approve: true, reviewedSha: SHA },
      undefined,
    );

    expect(decision.event).toBe('COMMENT');
    expect(decision.note).toContain('could not confirm the current PR head');
  });

  it('does not approve while any review thread is unresolved', async () => {
    const { octokit } = octokitWithThreads([true, false, false]);

    const decision = await decideReviewEvent(
      octokit,
      { ...PR, approve: true, reviewedSha: SHA },
      SHA,
    );

    expect(decision.event).toBe('COMMENT');
    expect(decision.note).toContain('2 unresolved review thread(s)');
  });

  it('does not approve when the threads cannot be read', async () => {
    const graphql = vi.fn().mockRejectedValue(new Error('403'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const decision = await decideReviewEvent(
      { graphql } as unknown as Octokit,
      { ...PR, approve: true, reviewedSha: SHA },
      SHA,
    );

    expect(decision.event).toBe('COMMENT');
    expect(decision.note).toContain('could not check');
  });
});

describe('dismissOwnApprovals', () => {
  function octokitWithReviews(
    reviews: Array<{ id: number; state: string; login: string }>,
  ) {
    const listReviews = vi.fn();
    const dismissReview = vi.fn().mockResolvedValue({});
    const paginate = vi.fn().mockResolvedValue(
      reviews.map((r) => ({
        id: r.id,
        state: r.state,
        user: { login: r.login },
      })),
    );
    const octokit = {
      paginate,
      rest: { pulls: { listReviews, dismissReview } },
    } as unknown as Octokit;
    return { octokit, paginate, listReviews, dismissReview };
  }

  it("dismisses only this bot's own approvals", async () => {
    const { octokit, paginate, listReviews, dismissReview } =
      octokitWithReviews([
        { id: 1, state: 'APPROVED', login: 'review-bot[bot]' },
        { id: 2, state: 'COMMENTED', login: 'review-bot[bot]' },
        { id: 3, state: 'APPROVED', login: 'alice' },
        { id: 4, state: 'DISMISSED', login: 'review-bot[bot]' },
      ]);

    const dismissed = await dismissOwnApprovals(octokit, PR, 'review-bot[bot]');

    expect(dismissed).toBe(1);
    expect(paginate).toHaveBeenCalledWith(listReviews, {
      owner: 'acme',
      repo: 'payments',
      pull_number: 7,
      per_page: 100,
    });
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'payments',
      pull_number: 7,
      review_id: 1,
      message: DISMISS_MESSAGE,
    });
  });

  it('never throws, so the posted review is not retried and duplicated', async () => {
    const { octokit, dismissReview } = octokitWithReviews([
      { id: 1, state: 'APPROVED', login: 'review-bot[bot]' },
    ]);
    dismissReview.mockRejectedValue(new Error('422'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      dismissOwnApprovals(octokit, PR, 'review-bot[bot]'),
    ).resolves.toBe(0);
  });
});
