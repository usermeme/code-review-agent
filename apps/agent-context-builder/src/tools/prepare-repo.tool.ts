import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { STATE } from '../constants/state-keys.constant.js';
import { cloneShallow } from '../services/clone.service.js';
import { collectFiles, buildChunks } from '../services/chunker.service.js';
import { collectAgentDocs } from '../services/agent-docs.service.js';

export interface PrepareRepoPayload {
  repo: string;
  ref: string;
  cloneUrl: string;
  token?: string;
  maxChunkTokens: number;
  maxChunks: number;
}

export function createPrepareRepoTool() {
  return new FunctionTool({
    name: 'prepare_repository',
    description: 'Clones the repository, chunks it, and extracts agent docs. Call this first.',
    parameters: z.object({
      repo: z.string().describe('owner/name'),
      ref: z.string(),
      cloneUrl: z.string(),
      token: z.string().optional(),
    }),
    execute: async (input, ctx) => {
      // Configuration can be hardcoded or injected.
      const options = {
        maxChunkTokens: 25000,
        maxChunks: 50,
        extraIgnores: [],
      };

      const cloned = await cloneShallow({
        cloneUrl: input.cloneUrl,
        ref: input.ref,
        token: input.token,
      });

      const files = await collectFiles(cloned.dir, options.extraIgnores);
      const agentDocs = collectAgentDocs(files);
      const { chunks, overflow } = buildChunks(files, options);

      // Store in AgentContext for subsequent tools
      ctx.state[STATE.repoDir] = cloned.dir;
      ctx.state[STATE.headSha] = cloned.headSha;
      ctx.state[STATE.chunks] = chunks;
      ctx.state[STATE.overflowPaths] = overflow;
      ctx.state[STATE.agentDocs] = agentDocs;

      return `Repository prepared successfully. Found ${chunks.length} chunks, ${overflow.length} overflow files, and agent docs extracted.`;
    },
  });
}
