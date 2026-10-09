import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { STATE } from '../constants/state-keys.constant.js';

export interface StoreContextResult {
  provider: string;
  owner: string;
  repo: string;
  prNumber?: number;
  sections: Record<string, string>;
}

export interface StoreContextToolDependencies {
  onStoreContext?: (result: StoreContextResult) => Promise<void> | void;
}

export function createStoreContextTool(
  deps: StoreContextToolDependencies = {},
) {
  return new FunctionTool({
    name: 'store_context',
    description: 'Stores the synthesized context sections.',
    parameters: z.object({
      provider: z.string(),
      owner: z.string(),
      repo: z.string(),
      prNumber: z.number().nullable().optional(),
      sections: z.record(z.string(), z.string()),
    }),
    execute: async (input, ctx) => {
      ctx?.state?.set(STATE.synthesizedSections, input.sections);

      if (deps.onStoreContext) {
        await deps.onStoreContext({
          provider: input.provider,
          owner: input.owner,
          repo: input.repo,
          prNumber: input.prNumber || 0,
          sections: input.sections,
        });
      }

      return 'Context successfully stored.';
    },
  });
}
