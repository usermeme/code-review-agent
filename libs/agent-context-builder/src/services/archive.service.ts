import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { GitAdapterContract } from 'shared-types';
import * as tar from 'tar';

export interface RepoSnapshot {
  dir: string;
  headSha: string;
  cleanup: () => Promise<void>;
}

export function parseRepoCoordinates(cloneUrl?: string): {
  owner?: string;
  repo?: string;
} {
  if (!cloneUrl) return {};
  const match = cloneUrl.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return {};
}

/**
 * Downloads and extracts a repository archive via the Git adapter.
 * Uses streaming tar extraction in Node.js — zero git CLI or direct provider dependencies required.
 */
export async function downloadRepoArchive(params: {
  cloneUrl?: string;
  ref?: string;
  owner?: string;
  repo?: string;
  gitAdapter: GitAdapterContract;
}): Promise<RepoSnapshot> {
  let { owner, repo } = params;
  if (!owner || !repo) {
    const coords = parseRepoCoordinates(params.cloneUrl);
    owner = coords.owner;
    repo = coords.repo;
  }

  if (!owner || !repo) {
    throw new Error(
      'Owner and repository name are required to fetch repository archive.',
    );
  }

  const ref = params.ref || 'main';
  const dir = await mkdtemp(join(tmpdir(), 'repoctx-'));

  try {
    const response = await params.gitAdapter.getRepoTarball(owner, repo, ref);

    if (!response.body) {
      throw new Error(
        `Repository archive response body from git adapter was empty.`,
      );
    }

    const body = response.body;
    const isWebStream =
      typeof body === 'object' &&
      body !== null &&
      'getReader' in body &&
      typeof (body as { getReader?: unknown }).getReader === 'function';

    const stream = isWebStream
      ? Readable.fromWeb(
          body as unknown as Parameters<typeof Readable.fromWeb>[0],
        )
      : (body as unknown as NodeJS.ReadableStream);

    // Extract the tar.gz stream directly into dir, stripping the top-level directory prefix
    await pipeline(
      stream,
      tar.x({
        cwd: dir,
        strip: 1,
      }),
    );

    const headSha =
      response.headers.get('x-commit-sha') ||
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
