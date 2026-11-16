import type { Octokit } from 'octokit';

import { fetchReviewThreads } from './review-threads.query.js';

export type ReviewEvent = 'APPROVE' | 'COMMENT';

export interface PullRequestRef {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface ApprovalRequest extends PullRequestRef {
  /** Core's verdict: a completed review with zero findings. */
  approve?: boolean;
  /** Head commit that review covered. */
  reviewedSha?: string;
}

export interface ReviewEventDecision {
  event: ReviewEvent;
  /** Appended to the review body when an approval was requested but withheld. */
  note: string;
}

export const DISMISS_MESSAGE =
  'A newer review of this pull request found issues; see the latest review.';

function withheld(reason: string): ReviewEventDecision {
  return {
    event: 'COMMENT',
    note: `\n\n<sub>No new findings, but not approved: ${reason}</sub>`,
  };
}

/** Unresolved review threads on the PR (any author), or undefined if unreadable. */
async function countUnresolvedThreads(
  octokit: Octokit,
  ref: PullRequestRef,
): Promise<number | undefined> {
  try {
    const threads = await fetchReviewThreads(octokit.graphql, {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.prNumber,
    });
    return threads.filter((thread) => !thread.isResolved).length;
  } catch (error) {
    console.warn(
      '[GithubService] Could not read review threads; not approving',
      error,
    );
    return undefined;
  }
}

function headMismatch(
  request: ApprovalRequest,
  headSha: string | undefined,
): ReviewEventDecision | undefined {
  if (!headSha) return withheld('could not confirm the current PR head.');
  if (headSha !== request.reviewedSha) {
    return withheld(
      'new commits were pushed after this review; they are reviewed separately.',
    );
  }
  return undefined;
}

function threadsVerdict(open: number | undefined): ReviewEventDecision {
  if (open === undefined) {
    return withheld('could not check for unresolved review threads.');
  }
  if (open > 0) {
    return withheld(`${open} unresolved review thread(s) on this PR.`);
  }
  return { event: 'APPROVE', note: '' };
}

/**
 * Approves only what core marked clean, only on the commit that was
 * reviewed, and only when no review thread is still open: a finding from an
 * earlier push, or one another reviewer raised, keeps the PR unapproved
 * until someone resolves it. Anything uncertain falls back to a comment.
 */
export async function decideReviewEvent(
  octokit: Octokit,
  request: ApprovalRequest,
  headSha: string | undefined,
): Promise<ReviewEventDecision> {
  if (!request.approve) return { event: 'COMMENT', note: '' };
  const mismatch = headMismatch(request, headSha);
  if (mismatch) return mismatch;
  return threadsVerdict(await countUnresolvedThreads(octokit, request));
}

/**
 * Dismisses approvals `login` (this app's bot user) left earlier on the PR.
 * Never throws: the new review is already posted, and a retry would post it
 * twice. Returns how many approvals were dismissed.
 */
export async function dismissOwnApprovals(
  octokit: Octokit,
  ref: PullRequestRef,
  login: string,
): Promise<number> {
  const pr = { owner: ref.owner, repo: ref.repo, pull_number: ref.prNumber };
  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      ...pr,
      per_page: 100,
    });
    const own = reviews.filter(
      (review) => review.state === 'APPROVED' && review.user?.login === login,
    );
    for (const review of own) {
      await octokit.rest.pulls.dismissReview({
        ...pr,
        review_id: review.id,
        message: DISMISS_MESSAGE,
      });
    }
    return own.length;
  } catch (error) {
    console.warn('[GithubService] Could not dismiss earlier approvals', error);
    return 0;
  }
}
