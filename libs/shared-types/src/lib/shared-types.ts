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
  /** Head commit of the PR; with prKey it identifies one reviewable revision. */
  headSha?: string;
}

export interface PREventPayload {
  prMeta: PRMeta;
  diff: string;
  changedFiles: string[];
}

export interface ReviewCommentPayload {
  path: string;
  position?: number;
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
