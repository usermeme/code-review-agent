export interface PostReviewOptions {
  owner: string;
  repo: string;
  prNumber: number;
  summary?: string;
  comments: {
    path: string;
    line: number;
    startLine?: number;
    body: string;
  }[];
  /** Core marked the review clean; see `decideReviewEvent` for the checks. */
  approve?: boolean;
  /** Head commit the review covered; an approval is pinned to it. */
  reviewedSha?: string;
}

export interface PostReviewResult {
  success: boolean;
  message: string;
  reviewId?: string;
  /** How the review was posted; absent for the issue-comment fallback. */
  event?: 'APPROVE' | 'COMMENT';
}
