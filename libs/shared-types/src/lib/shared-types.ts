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

export interface RepoRef {
  provider: string;
  owner: string;
  repo: string;
}

/** `provider:owner:repo` — the storage key of a repository's context. */
export function toRepoKey(ref: RepoRef): string {
  return `${ref.provider}:${ref.owner}:${ref.repo}`;
}

/** `provider:owner:repo:prNumber` — the storage key of a pull request. */
export function toPrKey(ref: RepoRef, prNumber: number): string {
  return `${toRepoKey(ref)}:${prNumber}`;
}

/** LLM-written sections of a repository context document. */
export interface RepoContextSections {
  architecture: string;
  modules: string;
  patterns: string;
  errorHandling: string;
}

/** Convention docs (AGENTS.md, CLAUDE.md, ...) kept verbatim, never summarized. */
export interface AgentDoc {
  path: string;
  content: string;
}

export interface RepoContextContent {
  sections: RepoContextSections;
  agentDocs: AgentDoc[];
}

export interface RepoContext extends RepoContextContent {
  repoKey: string;
  /** Commit the baseline was built from, when the provider reports it. */
  headSha?: string;
  /** Last merged PR folded in by an incremental update (dedupes redelivery). */
  lastAppliedPrNumber?: number;
  updatedAt: Date;
}

/** Message on the context-build topic, consumed by core's push route. */
export type ContextBuildRequest = RepoRef &
  (
    | {
        mode: 'baseline';
        ref?: string;
        /** PR waiting for this baseline; reviewed once the build is saved. */
        pendingPrNumber?: number;
      }
    | {
        mode: 'incremental';
        /** The merged PR whose changes get folded into the baseline. */
        prNumber: number;
      }
  );

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
}

export interface PREventPayload {
  prMeta: PRMeta;
  diff: string;
  changedFiles: string[];
}

export interface ReviewCommentPayload {
  path: string;
  /** Line on the new side of the diff the comment anchors to (the range end). */
  line: number;
  /** First line of a multi-line range; omitted for single-line comments. */
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
  token?: string;
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
