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
  /** Head commit covered by the last review; later pushes are reviewed as a delta. */
  lastReviewedSha?: string;
  /** Outcome and token usage of the most recent comment-judge run. */
  lastJudgment?: CommentJudgeMetrics;
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
  /** Review thread (GraphQL node id) a `thread_resolved` event is about. */
  threadId?: string;
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
  /** Absent on messages published before thread judgments existed. */
  kind?: 'review';
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
  /**
   * Set by core when a light or deep review ran to completion (the agent's
   * own submission, not a fallback draft) and left zero findings. The adapter
   * approves only if the PR head is still `reviewedSha` and the PR has no
   * unresolved review threads; otherwise it posts a normal comment review.
   */
  approve?: boolean;
  /** Head commit the review covered; an approval is pinned to it. */
  reviewedSha?: string;
}

export interface ReviewThreadComment {
  author: string;
  body: string;
  /** GraphQL node id; a reaction target. */
  id?: string;
  /** ISO timestamp. */
  createdAt?: string;
  /** Commit the comment was written against. */
  originalCommitSha?: string;
  /** Diff hunk the comment was attached to, as it was then. */
  diffHunk?: string;
}

/** An inline review thread on a PR, from any author (this bot, other bots, people). */
export interface ReviewThread {
  id: string;
  path: string;
  /** Current NEW-side line on the PR head; null when the thread is outdated. */
  line: number | null;
  isResolved: boolean;
  /** True when the code the thread was anchored to has since changed. */
  isOutdated: boolean;
  /** Line on the commit the thread was opened against. */
  originalLine?: number | null;
  /** Login that resolved the thread, when resolved. */
  resolvedBy?: string | null;
  /** The opening comment first, then the latest replies, oldest first. */
  comments: ReviewThreadComment[];
}

/** What the comment judge decided about one resolved thread. */
export type ThreadVerdict = 'fixed' | 'not_fixed' | 'accepted';

/**
 * - `queued`: a `resolved` event arrived; waiting to be judged.
 * - `pending`: resolved before any commit after the comment; judged on the next push.
 * - `skipped`: not judged (`[skip judge]`, re-opened or gone before judging).
 * - `escalated`: judged `not_fixed` too often; left to a human for good.
 */
export type ThreadJudgmentStatus =
  ThreadVerdict | 'queued' | 'pending' | 'skipped' | 'escalated';

export interface ThreadJudgmentRecord {
  verdict: ThreadVerdict;
  headSha: string;
  judgedAt: Date;
}

/** Firestore `thread_judgments`: the judge's state for one review thread. */
export interface ThreadJudgmentDoc {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** `provider:owner:repo:prNumber`, for per-PR queries. */
  prKey: string;
  /** GraphQL node id of the thread. */
  threadId: string;
  status: ThreadJudgmentStatus;
  /** When the latest `resolved` event queued the thread (epoch ms). */
  queuedAtMs: number;
  /** `not_fixed` verdicts so far; the third one escalates. */
  notFixedCount: number;
  lastVerdict?: ThreadJudgmentRecord & { reason: string; model: string };
  /** Newest last, at most 10. */
  history: ThreadJudgmentRecord[];
  /** Why the thread was skipped, when `status` is `skipped`. */
  skipReason?: string;
  updatedAt: Date;
}

/** One change the adapter makes on GitHub for a judged thread. */
export type ThreadJudgmentAction =
  | {
      /** Re-open the thread and reply with what is still wrong. */
      type: 'reopen';
      threadId: string;
      body: string;
    }
  | {
      /** Confirm a correct resolution with a reaction. */
      type: 'react';
      threadId: string;
      /** GraphQL node id of the comment to react to. */
      commentId: string;
    };

/** Published on the review-results topic next to review results. */
export interface ThreadJudgmentsPayload {
  kind: 'thread-judgments';
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  actions: ThreadJudgmentAction[];
  /** True when a thread was re-opened: an earlier bot approval no longer holds. */
  dismissApprovals: boolean;
}

/** Recorded on the PR after each comment-judge run. */
export interface CommentJudgeMetrics {
  judgedAt: Date;
  /** Threads sent to the model. */
  judged: number;
  verdicts: Record<ThreadVerdict, number>;
  pending: number;
  skipped: number;
  escalated: number;
  usage: TokenUsage;
  /** Set when the run failed; queued threads are retried on the next event. */
  failure?: string;
}

export interface PRDiffResult {
  diff: string;
  changedFiles: string[];
}

/**
 * Diff between two commits. `ahead` means `base` is an ancestor of `head`
 * (a plain push); anything else (diverged, behind, identical) means the
 * branch was rewritten or did not move.
 */
export interface CompareDiffResult extends PRDiffResult {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
}

export interface GitAdapterContract {
  getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRDiffResult>;
  getRepoTarball(owner: string, repo: string, ref?: string): Promise<Response>;
  /** UTF-8 content of `path` at `ref`, or null when there is no such file. */
  getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null>;
  getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ReviewThread[]>;
  getCompareDiff(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<CompareDiffResult>;
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
