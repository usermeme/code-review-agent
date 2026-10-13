import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { GitAdapterContract } from '@code-review-agent/shared-types';
import * as tar from 'tar';

export interface RepoSnapshot {
  dir: string;
  headSha?: string;
  cleanup: () => Promise<void>;
}

/**
 * Downloads and extracts a repository archive via the Git adapter into a temp
 * directory. The caller owns the snapshot and must call `cleanup()` — on Cloud
 * Run /tmp is in-memory, so a leaked checkout is leaked RAM.
 */
export async function downloadRepoArchive(params: {
  owner: string;
  repo: string;
  ref?: string;
  gitAdapter: GitAdapterContract;
}): Promise<RepoSnapshot> {
  const dir = await mkdtemp(join(tmpdir(), 'repoctx-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });

  try {
    const response = await params.gitAdapter.getRepoTarball(
      params.owner,
      params.repo,
      params.ref,
    );
    if (!response.body) {
      throw new Error('Repository archive response body was empty.');
    }

    // Extract the tar.gz stream directly into dir, stripping the top-level directory prefix
    await pipeline(
      Readable.fromWeb(
        response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      ),
      tar.x({ cwd: dir, strip: 1 }),
    );

    const headSha =
      response.headers.get('x-commit-sha') ??
      response.headers.get('x-github-commit-sha') ??
      undefined;

    return { dir, headSha, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
