import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import type { RepoScope } from './repo-scope.js';

export interface SearchRepositoryCodeToolDependencies {
  scope: RepoScope;
}

export function createSearchRepositoryCodeTool(
  deps: SearchRepositoryCodeToolDependencies,
) {
  const { gitAdapter, owner, repo } = deps.scope;
  return new FunctionTool({
    name: 'searchRepositoryCode',
    description:
      'Searches the repository codebase for symbols, function definitions, callers, or text queries. Use this ONLY to verify a specific defect hypothesis or to check if an existing helper/utility exists.',
    parameters: z.object({
      query: z
        .string()
        .describe('Search query keyword, symbol name, or function signature'),
    }),
    execute: async (input) => {
      try {
        const result = await gitAdapter.searchCode(owner, repo, input.query);
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
