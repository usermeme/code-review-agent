import { estimateTokens } from '@code-review-agent/llm';
import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { STATE } from '../constants/state-keys.constant.js';
import { collectAgentDocs } from '../services/agent-docs.service.js';
import { downloadRepoArchive } from '../services/archive.service.js';
import {
  buildChunks,
  collectFiles,
  type RepoFile,
} from '../services/chunker.service.js';

export interface PrepareRepoPayload {
  provider: string;
  owner: string;
  repo: string;
  ref?: string;
  cloneUrl?: string;
  prNumber?: number;
  isIncrementalUpdate?: boolean;
}

export interface PrepareRepoToolDependencies {
  gitAdapter?: GitAdapterContract;
}

export function createPrepareRepoTool(deps: PrepareRepoToolDependencies = {}) {
  return new FunctionTool({
    name: 'prepare_repository',
    description:
      'Clones the repository or fetches PR diffs, chunks files, and extracts agent docs. Call this first.',
    parameters: z.object({
      provider: z.string(),
      owner: z.string(),
      repo: z.string(),
      ref: z.string().optional(),
      cloneUrl: z.string().optional(),
      prNumber: z.number().nullable().optional(),
      isIncrementalUpdate: z.boolean().optional(),
    }),
    execute: async (input, ctx) => {
      const options = {
        maxChunkTokens: 25000,
        maxChunks: 50,
        extraIgnores: [],
      };

      if (!deps.gitAdapter) {
        throw new Error(
          'Git adapter contract is required to prepare repository context.',
        );
      }

      if (input.isIncrementalUpdate && input.prNumber) {
        // INCREMENTAL MODE: Fetch changed files using Git Adapter
        const changedFilesData = await deps.gitAdapter.getPRFiles(
          input.owner,
          input.repo,
          input.prNumber,
        );

        const filesRecord: RepoFile[] = [];

        for (const file of changedFilesData) {
          if (file.status === 'removed' || !file.content) continue;

          filesRecord.push({
            path: file.filename,
            content: file.content,
            tokens: estimateTokens(file.content),
          });
        }

        const agentDocs = collectAgentDocs(filesRecord);
        const { chunks, overflow } = buildChunks(filesRecord, options);

        ctx?.state?.set(STATE.chunks, chunks);
        ctx?.state?.set(STATE.overflowPaths, overflow);
        ctx?.state?.set(STATE.agentDocs, agentDocs);

        return `Incremental update prepared successfully. Found ${chunks.length} chunks of changed files.`;
      } else {
        // BASELINE MODE: Download repository archive via Git Adapter
        const ref = input.ref || 'main';

        const snapshot = await downloadRepoArchive({
          cloneUrl: input.cloneUrl,
          ref,
          owner: input.owner,
          repo: input.repo,
          gitAdapter: deps.gitAdapter,
        });

        const files = await collectFiles(snapshot.dir, options.extraIgnores);
        const agentDocs = collectAgentDocs(files);
        const { chunks, overflow } = buildChunks(files, options);

        ctx?.state?.set(STATE.repoDir, snapshot.dir);
        ctx?.state?.set(STATE.headSha, snapshot.headSha);
        ctx?.state?.set(STATE.chunks, chunks);
        ctx?.state?.set(STATE.overflowPaths, overflow);
        ctx?.state?.set(STATE.agentDocs, agentDocs);

        return `Baseline repository prepared successfully. Found ${chunks.length} chunks and ${overflow.length} overflow files.`;
      }
    },
  });
}
