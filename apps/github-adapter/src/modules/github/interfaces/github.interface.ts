import type {
  CodeSearchItem,
  CodeSearchResult,
  FileContentResult,
  GitAdapterContract,
  PRDiffResult,
  PRFile,
} from 'shared-types';

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
  comments: { path: string; position?: number; line?: number; body: string }[];
}

export interface PostReviewResult {
  success: boolean;
  message: string;
  reviewId?: string;
}
