export interface PostReviewOptions {
  owner: string;
  repo: string;
  prNumber: number;
  summary?: string;
  ticketCoverage?: string;
  comments: { path: string; position?: number; line?: number; body: string }[];
}

export interface PostReviewResult {
  success: boolean;
  message: string;
  reviewId?: string;
}

export interface PRDiffResult {
  diff: string;
  changedFiles: string[];
}

export interface CodeSearchResult {
  totalCount: number;
  items: Array<{
    name: string;
    path: string;
    sha: string;
    htmlUrl: string;
  }>;
}

export interface FileContentResult {
  path: string;
  content: string;
  encoding: string;
  sha?: string;
}
