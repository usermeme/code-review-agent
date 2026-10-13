import type {
  CodeSearchItem,
  CodeSearchResult,
  FileContentResult,
  GitAdapterContract,
  PRDiffResult,
  PRFile,
  ReviewCommentPayload,
} from '@code-review-agent/shared-types';

export type {
  CodeSearchItem,
  CodeSearchResult,
  FileContentResult,
  GitAdapterContract,
  PRDiffResult,
  PRFile,
};

export interface PostReviewOptions {
  owner: string;
  repo: string;
  prNumber: number;
  summary?: string;
  ticketCoverage?: string;
  comments: ReviewCommentPayload[];
}

export interface PostReviewResult {
  success: boolean;
  message: string;
  reviewId?: string;
}
