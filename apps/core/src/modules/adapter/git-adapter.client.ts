import { ENDPOINTS, interpolatePath } from '@code-review-agent/endpoints';
import type {
  CodeSearchResult,
  FileContentResult,
  GitAdapterContract,
  PRDiffResult,
  PRFile,
} from '@code-review-agent/shared-types';

export class GitAdapterClient implements GitAdapterContract {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRDiffResult> {
    const path = interpolatePath(ENDPOINTS.PR_DIFF, {
      Path: { owner, repo, prNumber },
    });
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch PR diff from git adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as PRDiffResult;
  }

  async getPRFiles(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRFile[]> {
    const path = interpolatePath(ENDPOINTS.PR_FILES, {
      Path: { owner, repo, prNumber },
    });
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch PR files from git adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as PRFile[];
  }

  async searchCode(
    owner: string,
    repo: string,
    query: string,
  ): Promise<CodeSearchResult> {
    const path = interpolatePath(ENDPOINTS.SEARCH_CODE, {
      Path: { owner, repo },
      Query: { q: query },
    });
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to search code from git adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as CodeSearchResult;
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<FileContentResult> {
    const interpolated = interpolatePath(ENDPOINTS.FILE_CONTENT, {
      Path: { owner, repo, path },
      Query: ref ? { ref } : undefined,
    });
    const url = `${this.baseUrl}${interpolated}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch file content from git adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as FileContentResult;
  }

  async getRepoTarball(
    owner: string,
    repo: string,
    ref?: string,
  ): Promise<Response> {
    const path = interpolatePath(ENDPOINTS.TARBALL, {
      Path: { owner, repo },
      Query: ref ? { ref } : undefined,
    });
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch repo tarball from git adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return res;
  }
}
