import type {
  GitAdapterContract,
  PRDiffResult,
  CodeSearchResult,
  FileContentResult,
} from 'shared-types';

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
    const url = `${this.baseUrl}/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/diff`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch PR diff from git adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as PRDiffResult;
  }

  async searchCode(
    owner: string,
    repo: string,
    query: string,
  ): Promise<CodeSearchResult> {
    const url = `${this.baseUrl}/api/v1/repos/${owner}/${repo}/search?q=${encodeURIComponent(query)}`;
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
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const url = `${this.baseUrl}/api/v1/repos/${owner}/${repo}/files/${path}${query}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch file content from git adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as FileContentResult;
  }
}
