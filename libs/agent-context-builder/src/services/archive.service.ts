import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { GitAdapterContract } from '@code-review-agent/shared-types';
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
 * Resolves the owner/repo coordinates from the explicit params, falling back
 * to parsing the clone URL when either is missing.
 */
function resolveOwnerAndRepo(params: {
  cloneUrl?: string;
  owner?: string;
  repo?: string;
}): { owner: string; repo: string } {
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

  return { owner, repo };
}

/** True for WHATWG web streams (duck-typed), as opposed to Node.js streams. */
function isWebStream(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'getReader' in body &&
    typeof (body as { getReader?: unknown }).getReader === 'function'
  );
}

/** Normalizes an adapter response body into a Node.js readable stream. */
function toNodeStream(body: unknown): NodeJS.ReadableStream {
  return isWebStream(body)
    ? Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
    : (body as NodeJS.ReadableStream);
}

/** Best-effort commit identity: adapter headers first, then the requested ref. */
function resolveHeadSha(headers: Headers, ref: string): string {
  return (
    headers.get('x-commit-sha') ||
    headers.get('x-github-commit-sha') ||
    headers.get('etag')?.replace(/"/g, '') ||
    ref
  );
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
  const { owner, repo } = resolveOwnerAndRepo(params);

  const ref = params.ref || 'main';
  const dir = await mkdtemp(join(tmpdir(), 'repoctx-'));

  try {
    const response = await params.gitAdapter.getRepoTarball(owner, repo, ref);

    if (!response.body) {
      throw new Error(
        `Repository archive response body from git adapter was empty.`,
      );
    }

    const stream = toNodeStream(response.body);

    // Extract the tar.gz stream directly into dir, stripping the top-level directory prefix
    await pipeline(
      stream,
      tar.x({
        cwd: dir,
        strip: 1,
      }),
    );

    const headSha = resolveHeadSha(response.headers, ref);

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
