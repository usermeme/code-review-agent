import { estimateTokens } from '@code-review-agent/llm';
import type { GitAdapterContract } from '@code-review-agent/shared-types';

import type { RepoFile } from '../repo/file-walker.js';

export interface PrFileChanges {
  files: RepoFile[];
  deletedPaths: string[];
}

/** Fetches the post-merge content of a PR's changed files plus the paths it deleted. */
export async function collectPrFiles(params: {
  owner: string;
  repo: string;
  prNumber: number;
  gitAdapter: GitAdapterContract;
}): Promise<PrFileChanges> {
  const prFiles = await params.gitAdapter.getPRFiles(
    params.owner,
    params.repo,
    params.prNumber,
  );

  const files: RepoFile[] = [];
  const deletedPaths: string[] = [];
  for (const file of prFiles) {
    if (file.status === 'removed') {
      deletedPaths.push(file.filename);
      continue;
    }
    if (!file.content) continue;
    files.push({
      path: file.filename,
      content: file.content,
      tokens: estimateTokens(file.content),
    });
  }
  return { files, deletedPaths };
}
