import { FunctionTool } from '@google/adk';
import type { GitAdapterContract } from 'shared-types';
import { z } from 'zod';

import { type PrMeta, STATE } from '../constants/state-keys.constant.js';

export interface SearchRepositoryCodeToolDependencies {
  gitAdapter?: GitAdapterContract;
  defaultOwner?: string;
  defaultRepo?: string;
}

export function createSearchRepositoryCodeTool(
  deps: SearchRepositoryCodeToolDependencies = {},
) {
  return new FunctionTool({
    name: 'searchRepositoryCode',
    description:
      'Searches the repository codebase for symbols, function definitions, callers, or text queries. Use this ONLY to verify a specific defect hypothesis or to check if an existing helper/utility exists.',
    parameters: z.object({
      query: z
        .string()
        .describe('Search query keyword, symbol name, or function signature'),
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
    }),
    execute: async (input, ctx) => {
      const meta = ctx?.state?.get<PrMeta>(STATE.prMeta);
      const owner = input.owner || meta?.owner || deps.defaultOwner || '';
      const repo = input.repo || meta?.repo || deps.defaultRepo || '';

      if (!deps.gitAdapter) {
        return {
          totalCount: 0,
          items: [],
          message: 'Git adapter is not configured for code search.',
        };
      }

      if (!owner || !repo) {
        return {
          totalCount: 0,
          items: [],
          message: 'Repository owner and name are required for search.',
        };
      }

      try {
        const result = await deps.gitAdapter.searchCode(
          owner,
          repo,
          input.query,
        );
        const items = (result.items || []).slice(0, 5).map((item) => ({
          name: item.name,
          path: item.path,
        }));

        return {
          totalCount: result.totalCount,
          items,
        };
      } catch (err) {
        return {
          totalCount: 0,
          items: [],
          message: `Code search failed: ${String(err)}`,
        };
      }
    },
  });
}
