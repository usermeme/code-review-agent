import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { STATE } from '../constants/state-keys.constant.js';
import { cloneShallow } from '../services/clone.service.js';
import { collectFiles, buildChunks } from '../services/chunker.service.js';
import { collectAgentDocs } from '../services/agent-docs.service.js';

export interface PrepareRepoPayload {
  provider: string;
  owner: string;
  repo: string;
  ref?: string;
  cloneUrl?: string;
  token?: string;
  prNumber?: number;
  isIncrementalUpdate?: boolean;
}

export function createPrepareRepoTool() {
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
      token: z.string().optional(),
      prNumber: z.number().nullable().optional(),
      isIncrementalUpdate: z.boolean().optional(),
    }),
    execute: async (input, ctx) => {
      const options = {
        maxChunkTokens: 25000,
        maxChunks: 50,
        extraIgnores: [],
      };

      if (input.isIncrementalUpdate && input.provider === 'github' && input.prNumber) {
        // INCREMENTAL MODE: Fetch only changed files using GitHub API
        const filesResponse = await fetch(
          `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/files`,
          {
            headers: input.token ? { Authorization: `Bearer ${input.token}` } : {},
          }
        );

        if (!filesResponse.ok) {
          throw new Error(`Failed to fetch PR files: ${filesResponse.status}`);
        }

        const changedFilesData = await filesResponse.json();
        const filesRecord: import('../services/chunker.service.js').RepoFile[] = [];
        const { estimateTokens } = await import('../services/tokens.util.js');

        for (const file of changedFilesData) {
          if (file.status === 'removed') continue;
          
          const contentResponse = await fetch(file.raw_url, {
            headers: input.token ? { Authorization: `Bearer ${input.token}` } : {},
          });
          
          if (contentResponse.ok) {
            const content = await contentResponse.text();
            filesRecord.push({
               path: file.filename,
               content,
               tokens: estimateTokens(content),
            });
          }
        }

        const agentDocs = collectAgentDocs(filesRecord);
        const { chunks, overflow } = buildChunks(filesRecord, options);

        ctx.state[STATE.chunks] = chunks;
        ctx.state[STATE.overflowPaths] = overflow;
        ctx.state[STATE.agentDocs] = agentDocs;

        return `Incremental update prepared successfully. Found ${chunks.length} chunks of changed files.`;
      } else {
        // BASELINE MODE: Clone entire repository
        if (!input.cloneUrl || !input.ref) {
           throw new Error('cloneUrl and ref are required for baseline context generation');
        }
        
        const cloned = await cloneShallow({
          cloneUrl: input.cloneUrl,
          ref: input.ref,
          token: input.token,
        });

        const files = await collectFiles(cloned.dir, options.extraIgnores);
        const agentDocs = collectAgentDocs(files);
        const { chunks, overflow } = buildChunks(files, options);

        ctx.state[STATE.repoDir] = cloned.dir;
        ctx.state[STATE.headSha] = cloned.headSha;
        ctx.state[STATE.chunks] = chunks;
        ctx.state[STATE.overflowPaths] = overflow;
        ctx.state[STATE.agentDocs] = agentDocs;

        return `Baseline repository prepared successfully. Found ${chunks.length} chunks and ${overflow.length} overflow files.`;
      }
    },
  });
}
