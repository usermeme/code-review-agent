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
}

export interface PostReviewResult {
  success: boolean;
  message: string;
  reviewId?: string;
}
