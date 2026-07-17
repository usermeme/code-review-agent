import type {
  RepositoryIdentifier,
  PullRequestDetails,
  PrDiff,
  ReviewComment,
} from '../types/vcs.types.js';

/**
 * Handles retrieving data from the platform.
 */
export interface PlatformClient {
  getPullRequest(
    repo: RepositoryIdentifier,
    prNumber: number,
  ): Promise<PullRequestDetails>;
  getPrFiles(repo: RepositoryIdentifier, prNumber: number): Promise<PrDiff[]>;
  getIssue(repo: RepositoryIdentifier, issueNumber: number): Promise<unknown>;

  getHistoricalDiscussions(
    repo: RepositoryIdentifier,
  ): AsyncIterableIterator<
    import('../types/vcs.types.js').HistoricalDiscussion
  >;

  // Clone and Auth capabilities
  getCloneToken(): Promise<string>;
  getCloneUrl(repo: RepositoryIdentifier): Promise<string>;
}

/**
 * Handles publishing actions and code reviews back to the platform.
 */
export interface CodeReviewPublisher {
  publishReview(
    repo: RepositoryIdentifier,
    prNumber: number,
    comments: ReviewComment[],
    generalSummary: string,
  ): Promise<void>;
}
