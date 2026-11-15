export interface PriorFinding {
  path: string;
  startLine: number;
  endLine: number;
  severity: 'critical' | 'major' | 'minor';
  title: string;
}

/** Token counts reported by the model, summed over every call of one role. */
export interface TokenUsage {
  calls: number;
  promptTokens: number;
  /** Part of `promptTokens` served from Gemini's implicit cache. */
  cachedTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}

/** Review depth chosen for a PR; `skip` means no review agent ran. */
export type ReviewTier = 'skip' | 'light' | 'deep';

export interface ReviewRoute {
  tier: ReviewTier;
  reason: string;
  /** Where the decision came from: a deterministic rule, the triage model, or the fail-open fallback. */
  source: 'rule' | 'triage' | 'fallback';
}

/** Per-review routing decision and token usage per agent role. */
export interface ReviewMetrics {
  route: ReviewRoute;
  usage: Partial<Record<'triage' | 'reviewer' | 'verifier', TokenUsage>>;
}

export interface PRState {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  status: 'queued' | 'reviewing' | 'completed' | 'skipped' | 'failed';
  updatedAt: Date;
  summary?: string;
  publishedFindings?: PriorFinding[];
  error?: string;
  /** Routing and token usage of the most recent review run. */
  lastReview?: ReviewMetrics;
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
  baseRef?: string;
  isIncrementalUpdate?: boolean;
  /** True while the PR is a draft; drafts are reviewed once marked ready. */
  isDraft?: boolean;
  /** Head commit of the PR at the time of the event. */
  headSha?: string;
}

export interface PREventPayload {
  prMeta: PRMeta;
}

export interface ReviewCommentPayload {
  path: string;
  line: number;
  startLine?: number;
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
