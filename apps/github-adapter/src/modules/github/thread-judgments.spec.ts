import type { ThreadJudgmentsPayload } from '@code-review-agent/shared-types';
import type { Octokit } from 'octokit';
import { describe, expect, it, vi } from 'vitest';

import { applyThreadJudgments } from './thread-judgments.js';

function payload(
  overrides: Partial<ThreadJudgmentsPayload> = {},
): ThreadJudgmentsPayload {
  return {
    kind: 'thread-judgments',
    provider: 'github',
    owner: 'acme',
    repo: 'payments',
    prNumber: 9,
    actions: [
      { type: 'reopen', threadId: 'T1', body: 'Still unchecked.' },
      { type: 'react', threadId: 'T2', commentId: 'C9' },
    ],
    dismissApprovals: true,
    ...overrides,
  };
}

function fakeOctokit(failing: string[] = []) {
  const graphql = vi.fn(async (query: string) => {
    const name = /mutation (\w+)/.exec(query)?.[1] ?? '';
    if (failing.includes(name)) throw new Error(`${name} failed`);
    if (name === 'Reply') {
      return {
        addPullRequestReviewThreadReply: {
          comment: { author: { login: 'reviewer-bot[bot]' } },
        },
      };
    }
    return {};
  });
  const listReviews = vi.fn();
  const dismissReview = vi.fn();
  const paginate = vi.fn().mockResolvedValue([
    { id: 1, state: 'APPROVED', user: { login: 'reviewer-bot[bot]' } },
    { id: 2, state: 'APPROVED', user: { login: 'alice' } },
  ]);
  const octokit = {
    graphql,
    paginate,
    rest: { pulls: { listReviews, dismissReview } },
  } as unknown as Octokit;
  return { octokit, graphql, dismissReview };
}

function mutationsCalled(graphql: ReturnType<typeof vi.fn>) {
  return graphql.mock.calls.map(([query, variables]) => [
    /mutation (\w+)/.exec(String(query))?.[1],
    variables,
  ]);
}

describe('applyThreadJudgments', () => {
  it('re-opens before replying, reacts, then dismisses only the bot approval', async () => {
    const { octokit, graphql, dismissReview } = fakeOctokit();

    const applied = await applyThreadJudgments(octokit, payload());

    expect(mutationsCalled(graphql)).toEqual([
      ['Unresolve', { threadId: 'T1' }],
      ['Reply', { threadId: 'T1', body: 'Still unchecked.' }],
      ['React', { subjectId: 'C9' }],
    ]);
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 1, pull_number: 9 }),
    );
    expect(applied).toEqual({
      reopened: 1,
      reacted: 1,
      failed: 0,
      dismissedApprovals: 1,
    });
  });

  it('keeps going when one action fails, and never throws', async () => {
    const { octokit, graphql } = fakeOctokit(['Unresolve']);

    const applied = await applyThreadJudgments(octokit, payload());

    expect(mutationsCalled(graphql).map(([name]) => name)).toEqual([
      'Unresolve',
      'React',
    ]);
    // Without a posted reply there is no bot login to dismiss approvals with.
    expect(applied).toEqual({
      reopened: 0,
      reacted: 1,
      failed: 1,
      dismissedApprovals: 0,
    });
  });

  it('leaves approvals alone when nothing was re-opened', async () => {
    const { octokit, dismissReview } = fakeOctokit();

    await applyThreadJudgments(
      octokit,
      payload({
        actions: [{ type: 'react', threadId: 'T2', commentId: 'C9' }],
        dismissApprovals: false,
      }),
    );

    expect(dismissReview).not.toHaveBeenCalled();
  });
});
