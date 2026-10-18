export interface PRState {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  status: 'queued' | 'building_context' | 'reviewing' | 'completed' | 'failed';
  updatedAt: Date;
  diff?: string;
  changedFiles?: string[];
  prMeta?: Partial<PRMeta> & Record<string, unknown>;
  summary?: string;
  error?: string;
}

export interface ContextReadyPayload {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  summary: string;
}

export interface RepositoryContext {
  prKey: string;
  summary: string;
  updatedAt: Date;
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
  diff: string;
  changedFiles: string[];
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
  ticketCoverage?: string;
}

export interface WebhookEventPayload {
  action: string;
  prNumber: number;
  owner: string;
  repo: string;
  htmlUrl: string;
  cloneUrl?: string;
  ref?: string;
  installationId?: number;
  isIncrementalUpdate?: boolean;
}

export interface PRDiffResult {
  diff: string;
  changedFiles: string[];
}

export interface CodeSearchItem {
  name: string;
  path: string;
  sha: string;
  htmlUrl: string;
}

export interface CodeSearchResult {
  totalCount: number;
  items: CodeSearchItem[];
}

export interface FileContentResult {
  path: string;
  content: string;
  encoding: string;
  sha?: string;
}

export interface PRFile {
  filename: string;
  status: string;
  content?: string;
  patch?: string;
}

export interface GitAdapterContract {
  getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRDiffResult>;
  getPRFiles(owner: string, repo: string, prNumber: number): Promise<PRFile[]>;
  searchCode(
    owner: string,
    repo: string,
    query: string,
  ): Promise<CodeSearchResult>;
  getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<FileContentResult>;
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
