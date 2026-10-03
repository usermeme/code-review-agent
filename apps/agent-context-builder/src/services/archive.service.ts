import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

export interface RepoSnapshot {
  dir: string;
  headSha: string;
  cleanup: () => Promise<void>;
}

export function parseRepoCoordinates(cloneUrl?: string): { owner?: string; repo?: string } {
  if (!cloneUrl) return {};
  const match = cloneUrl.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return {};
}

/**
 * Downloads and extracts a repository archive via the Git provider's REST API.
 * Uses streaming tar extraction in Node.js — zero git CLI or binary required.
 */
export async function downloadRepoArchive(params: {
  cloneUrl?: string;
  ref?: string;
  token?: string;
  owner?: string;
  repo?: string;
}): Promise<RepoSnapshot> {
  let { owner, repo } = params;
  if (!owner || !repo) {
    const coords = parseRepoCoordinates(params.cloneUrl);
    owner = coords.owner;
    repo = coords.repo;
  }

  if (!owner || !repo) {
    throw new Error('Owner and repository name are required to fetch repository archive.');
  }

  const ref = params.ref || 'main';
  const token = params.token || process.env.GIT_ADAPTER_TOKEN;

  const dir = await mkdtemp(join(tmpdir(), 'repoctx-'));

  const headers: Record<string, string> = {
    'User-Agent': 'code-review-agent',
    Accept: 'application/vnd.github+json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`;

  try {
    const response = await fetch(tarballUrl, {
      headers,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download repository archive from ${tarballUrl}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error(`Repository archive response body from ${tarballUrl} was empty.`);
    }

    // Extract the tar.gz stream directly into dir, stripping the top-level GitHub directory prefix
    await pipeline(
      Readable.fromWeb(response.body as any),
      tar.x({
        cwd: dir,
        strip: 1,
      }),
    );

    const headSha =
      response.headers.get('x-github-commit-sha') ||
      response.headers.get('etag')?.replace(/"/g, '') ||
      ref;

    return {
      dir,
      headSha,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
