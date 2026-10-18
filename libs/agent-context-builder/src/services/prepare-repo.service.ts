import type {
  GitAdapterContract,
  PRFile,
} from '@code-review-agent/shared-types';

import { STATE } from '../constants/state-keys.constant.js';
import { collectAgentDocs } from './agent-docs.service.js';
import { downloadRepoArchive } from './archive.service.js';
import {
  acceptFileContent,
  buildChunks,
  collectFiles,
  isIgnoredPath,
  type RepoFile,
} from './chunker.service.js';
import type { PipelineState } from './pipeline-state.js';
import { estimateTokens } from './tokens.util.js';

export interface PrepareRepoInput {
  provider: string;
  owner: string;
  repo: string;
  ref?: string;
  cloneUrl?: string;
  prNumber?: number;
  isIncrementalUpdate?: boolean;
}

export interface PrepareRepoDependencies {
  gitAdapter?: GitAdapterContract;
}

const CHUNK_OPTIONS = {
  maxChunkTokens: 25_000,
  maxChunks: 50,
  extraIgnores: [] as string[],
};

/**
 * Applies the changed-file filters to one PR file: removed files and files
 * without content are dropped silently; ignored/generated files are recorded
 * in `skipped`. Returns the accepted RepoFile, or null when skipped.
 */
function acceptChangedFile(file: PRFile, skipped: string[]): RepoFile | null {
  if (file.status === 'removed' || !file.content) return null;
  if (isIgnoredPath(file.filename)) {
    skipped.push(file.filename);
    return null;
  }
  const content = acceptFileContent(file.content);
  if (content === null) {
    skipped.push(file.filename);
    return null;
  }
  return {
    path: file.filename,
    content,
    tokens: estimateTokens(content),
  };
}

/**
 * INCREMENTAL MODE: fetch the PR's changed files via the Git adapter and
 * materialize them as chunks in state.
 */
async function prepareIncrementalUpdate(
  gitAdapter: GitAdapterContract,
  input: PrepareRepoInput,
  prNumber: number,
  state: PipelineState,
): Promise<string> {
  const changedFilesData = await gitAdapter.getPRFiles(
    input.owner,
    input.repo,
    prNumber,
  );

  const filesRecord: RepoFile[] = [];
  const skipped: string[] = [];

  for (const file of changedFilesData) {
    const accepted = acceptChangedFile(file, skipped);
    if (accepted) filesRecord.push(accepted);
  }

  const agentDocs = collectAgentDocs(filesRecord);
  const { chunks, overflow } = buildChunks(filesRecord, CHUNK_OPTIONS);

  state.set(STATE.chunks, chunks);
  state.set(STATE.overflowPaths, overflow);
  state.set(STATE.agentDocs, agentDocs);

  return `Incremental update prepared successfully. Found ${chunks.length} chunks of changed files${skipped.length > 0 ? `; skipped ${skipped.length} generated/ignored file(s)` : ''}.`;
}

/**
 * Pipeline step 1: materialize the repository (or the PR's changed files)
 * into chunks in state.
 *
 * Incremental mode applies the same ignore/size/generated-content filters as
 * the baseline tree walk — previously lockfiles, binaries and generated
 * bundles touched by a merged PR were fetched in full and summarized, which
 * was both expensive and pure noise for the context document.
 */
export async function prepareRepository(
  deps: PrepareRepoDependencies,
  input: PrepareRepoInput,
  state: PipelineState,
): Promise<string> {
  if (!deps.gitAdapter) {
    throw new Error(
      'Git adapter contract is required to prepare repository context.',
    );
  }

  if (input.isIncrementalUpdate && input.prNumber) {
    return prepareIncrementalUpdate(
      deps.gitAdapter,
      input,
      input.prNumber,
      state,
    );
  }

  // BASELINE MODE: download the repository archive via the Git adapter.
  const ref = input.ref || 'main';

  const snapshot = await downloadRepoArchive({
    cloneUrl: input.cloneUrl,
    ref,
    owner: input.owner,
    repo: input.repo,
    gitAdapter: deps.gitAdapter,
  });

  const files = await collectFiles(snapshot.dir, CHUNK_OPTIONS.extraIgnores);
  const agentDocs = collectAgentDocs(files);
  const { chunks, overflow } = buildChunks(files, CHUNK_OPTIONS);

  state.set(STATE.repoDir, snapshot.dir);
  state.set(STATE.headSha, snapshot.headSha);
  state.set(STATE.chunks, chunks);
  state.set(STATE.overflowPaths, overflow);
  state.set(STATE.agentDocs, agentDocs);

  return `Baseline repository prepared successfully. Found ${chunks.length} chunks and ${overflow.length} overflow files.`;
}
