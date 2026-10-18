import { ENDPOINTS, interpolatePath } from '@code-review-agent/endpoints';
import {
  type CodeSearchResult,
  type FileContentResult,
  type GitAdapterContract,
  NonRetryableTaskError,
  type PRDiffResult,
  type PRFile,
} from '@code-review-agent/shared-types';

interface AdapterErrorBody {
  error?: string;
  nonRetryable?: boolean;
}

async function readErrorBody(res: Response): Promise<AdapterErrorBody | null> {
  try {
    return (await res.json()) as AdapterErrorBody;
  } catch {
    return null;
  }
}

async function throwAdapterError(
  res: Response,
  action: string,
): Promise<never> {
  const body = await readErrorBody(res);
  if (body?.nonRetryable) {
    const detail = body.error || `HTTP ${res.status} ${res.statusText}`;
    throw new NonRetryableTaskError(
      `Failed to ${action} from git adapter: ${detail}`,
    );
  }
  throw new Error(
    `Failed to ${action} from git adapter: HTTP ${res.status} ${res.statusText}`,
  );
}

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
    return this.fetchJson<PRDiffResult>(path, 'fetch PR diff');
  }

  async getPRFiles(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRFile[]> {
    const path = interpolatePath(ENDPOINTS.PR_FILES, {
      Path: { owner, repo, prNumber },
    });
    return this.fetchJson<PRFile[]>(path, 'fetch PR files');
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
    return this.fetchJson<CodeSearchResult>(path, 'search code');
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
    return this.fetchJson<FileContentResult>(
      interpolated,
      'fetch file content',
    );
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
    return this.fetchResponse(path, 'fetch repo tarball');
  }

  private async fetchResponse(path: string, action: string): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      return throwAdapterError(res, action);
    }
    return res;
  }

  private async fetchJson<T>(path: string, action: string): Promise<T> {
    const res = await this.fetchResponse(path, action);
    return (await res.json()) as T;
  }
}
