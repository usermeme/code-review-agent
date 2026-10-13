import type { GitAdapterContract } from '@code-review-agent/shared-types';

import { downloadRepoArchive } from '../repo/archive.js';
import { collectFiles, type RepoFile } from '../repo/file-walker.js';

export interface BaselineFiles {
  files: RepoFile[];
  headSha?: string;
}

/** Downloads the repo at `ref`, reads its text files and always removes the checkout. */
export async function collectBaselineFiles(params: {
  owner: string;
  repo: string;
  ref?: string;
  gitAdapter: GitAdapterContract;
}): Promise<BaselineFiles> {
  const snapshot = await downloadRepoArchive(params);
  try {
    const files = await collectFiles(snapshot.dir);
    return { files, headSha: snapshot.headSha };
  } finally {
    await snapshot.cleanup();
  }
}
