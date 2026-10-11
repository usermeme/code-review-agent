import type {
  PRDiffResult,
  PRFile,
  CodeSearchItem,
  CodeSearchResult,
  FileContentResult,
  GitAdapterContract,
} from 'shared-types';

export type {
  PRDiffResult,
  PRFile,
  CodeSearchItem,
  CodeSearchResult,
  FileContentResult,
  GitAdapterContract,
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
