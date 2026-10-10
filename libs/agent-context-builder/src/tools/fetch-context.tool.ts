import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { STATE } from '../constants/state-keys.constant.js';

export type ContextLoader = (
  key: string,
) => Promise<Record<string, string> | null>;

export function createFetchContextTool(contextLoader?: ContextLoader) {
  return new FunctionTool({
    name: 'fetch_context',
    description: 'Fetches the existing baseline repository context.',
    parameters: z.object({
      provider: z.string(),
      owner: z.string(),
      repo: z.string(),
    }),
    execute: async (input, ctx) => {
      const repoKey = `${input.provider}:${input.owner}:${input.repo}:0`;

      if (ctx?.state?.get(STATE.existingContext)) {
        return 'Context already present in state.';
      }

      if (contextLoader) {
        const data = await contextLoader(repoKey);
        ctx?.state?.set(STATE.existingContext, data);
        return data
          ? `Successfully loaded existing context. Keys found: ${Object.keys(data).join(', ')}`
          : `No existing context found for ${repoKey}.`;
      }

      ctx?.state?.set(STATE.existingContext, null);
      return `No existing context found for ${repoKey}.`;
    },
  });
}
