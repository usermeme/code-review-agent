export interface PRDiffResponse {
  diff: string;
  changedFiles: string[];
}

export interface CodeSearchResponse {
  totalCount: number;
  items: Array<{
    name: string;
    path: string;
    sha: string;
    htmlUrl: string;
  }>;
}

export interface FileContentResponse {
  path: string;
  content: string;
  encoding: string;
  sha?: string;
}

export class GithubAdapterClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRDiffResponse> {
    const url = `${this.baseUrl}/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/diff`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch PR diff from adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as PRDiffResponse;
  }

  async searchCode(
    owner: string,
    repo: string,
    query: string,
  ): Promise<CodeSearchResponse> {
    const url = `${this.baseUrl}/api/v1/repos/${owner}/${repo}/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to search code from adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as CodeSearchResponse;
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<FileContentResponse> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const url = `${this.baseUrl}/api/v1/repos/${owner}/${repo}/files/${path}${query}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch file content from adapter: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as FileContentResponse;
  }
}
