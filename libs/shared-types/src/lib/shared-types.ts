export interface PriorFinding {
  path: string;
  startLine: number;
  endLine: number;
  severity: 'critical' | 'major' | 'minor';
  title: string;
}

export interface PRState {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  status: 'queued' | 'reviewing' | 'completed' | 'failed';
  updatedAt: Date;
  diff?: string;
  changedFiles?: string[];
  prMeta?: Partial<PRMeta> & Record<string, unknown>;
  summary?: string;
  publishedFindings?: PriorFinding[];
  error?: string;
}

export interface PRMeta {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  branch: string;
  body?: string;
  htmlUrl: string;
  action: string;
  cloneUrl?: string;
  baseRef?: string;
  isIncrementalUpdate?: boolean;
  /** Head commit of the PR at the time of the event. */
  headSha?: string;
}

export interface PREventPayload {
  prMeta: PRMeta;
  diff?: string;
  changedFiles?: string[];
}

export interface ReviewCommentPayload {
  path: string;
  /**
   * NEW-side line number the comment anchors to (mapped to GitHub's `line`).
   * Named `position` for historical reasons — it is a file line number, not
   * a diff-hunk position.
   */
  position?: number;
  /** NEW-side start line for multi-line comments (mapped to GitHub's `start_line`). */
  startPosition?: number;
  line?: number;
  body: string;
}

export interface ReviewResultPayload {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  comments: ReviewCommentPayload[];
  summary?: string;
  /**
   * Present when this payload reports a FAILED/abandoned review (timeout,
   * budget exhausted, non-retryable error) instead of findings. Published so
   * the failure is visible on the PR (the adapter posts `summary`) rather
   * than silently acked — `comments` is empty in that case.
   */
  failure?: {
    reason: string;
  };
}

export interface PRDiffResult {
  diff: string;
  changedFiles: string[];
}

export interface GitAdapterContract {
  getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRDiffResult>;
  getRepoTarball(owner: string, repo: string, ref?: string): Promise<Response>;
}

/**
 * An error whose retry cannot succeed (malformed input, a repository with
 * nothing summarizable, ...). Consumers should ack-and-record the failure
 * instead of nacking — redelivery would only repeat the same paid work and
 * eventually hit the dead-letter path anyway.
 */
export class NonRetryableTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableTaskError';
  }
}
