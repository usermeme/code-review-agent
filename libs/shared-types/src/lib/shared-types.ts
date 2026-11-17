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

/**
 * Where a review's rules came from: a stored context, a fresh build, no
 * sources on the base branch, or the raw-guidelines fallback.
 */
export type ReviewContextOrigin = 'cache' | 'built' | 'empty' | 'fallback';

/** How the review context was resolved for one review run. */
export interface ReviewContextMetrics {
  origin: ReviewContextOrigin;
  /** Content hash of the base-branch sources; absent on early fallbacks. */
  sourceHash?: string;
  /** Rules in the whole context. */
  ruleCount: number;
  /** Rules that matched this PR's changed files and reached the prompts. */
  selectedRules: number;
  /** Why the raw guidelines were used instead of rules. */
  fallbackReason?: string;
}

/** Per-review routing decision and token usage per agent role. */
export interface ReviewMetrics {
  route: ReviewRoute;
  usage: Partial<
    Record<'context' | 'triage' | 'reviewer' | 'verifier', TokenUsage>
  >;
  context?: ReviewContextMetrics;
}

export type FindingSeverity = 'critical' | 'major' | 'minor';

/** Where in the repository a review rule was written down. */
export interface ReviewRuleSource {
  path: string;
  startLine?: number;
  endLine?: number;
}

/**
 * One review rule extracted from the repository's guideline and skill
 * files: something a reviewer can check in a diff.
 */
export interface ReviewRule {
  /** Stable slug, unique within one context. */
  id: string;
  rule: string;
  /** Globs of the paths the rule covers; empty means the whole repository. */
  appliesTo: string[];
  severity: FindingSeverity;
  source: ReviewRuleSource;
}

export type ReviewContextSourceKind = 'guideline' | 'skill';

/** A guideline or skill file a review context was built from. */
export interface ReviewContextSource {
  path: string;
  kind: ReviewContextSourceKind;
  /** Git blob SHA of the file on the base branch. */
  blobSha: string;
  chars: number;
}

/** A source file the builder left out, and why. */
export interface DiscardedContextSource {
  path: string;
  reason: string;
}

/**
 * A stored review context (Firestore `review_contexts`). Content-addressed:
 * the id ends in `sourceHash`, and a document is never changed once written.
 */
export interface ReviewContextDoc {
  provider: string;
  owner: string;
  repo: string;
  sourceHash: string;
  builderVersion: number;
  status: 'ready' | 'failed';
  sources: ReviewContextSource[];
  rules: ReviewRule[];
  discarded: DiscardedContextSource[];
  model: string;
  usage: TokenUsage;
  builtAt: Date;
  /** Firestore TTL field; the context is rebuilt once after it expires. */
  expireAt: Date;
  /** Set when `status` is `failed`. */
  error?: string;
  /** Epoch ms after which a `failed` context may be rebuilt. */
  retryAfterMs?: number;
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
  comments: ReviewThreadComment[];
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

/** A file in a git tree, identified by its blob SHA. */
export interface RepoTreeFile {
  path: string;
  blobSha: string;
}

/** Files of a ref's tree whose basename matched the requested names. */
export interface RepoTreeFilesResult {
  files: RepoTreeFile[];
  /** True when the provider returned only part of a very large tree. */
  truncated: boolean;
}

export interface GitAdapterContract {
  getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRDiffResult>;
  getRepoTarball(owner: string, repo: string, ref?: string): Promise<Response>;
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
  /**
   * Lists the files of `ref`'s tree whose lowercased basename is one of
   * `names` (e.g. `agents.md`, `skill.md`).
   */
  listTreeFiles(
    owner: string,
    repo: string,
    ref: string,
    names: string[],
  ): Promise<RepoTreeFilesResult>;
  /** UTF-8 content of a git blob. */
  getBlob(owner: string, repo: string, blobSha: string): Promise<string>;
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
