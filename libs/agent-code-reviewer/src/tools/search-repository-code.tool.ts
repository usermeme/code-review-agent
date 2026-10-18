import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { type PrMeta, STATE } from '../constants/state-keys.constant.js';

export interface SearchRepositoryCodeToolDependencies {
  gitAdapter?: GitAdapterContract;
  defaultOwner?: string;
  defaultRepo?: string;
}

function readPinnedCoordinate(
  stateValue: string | undefined,
  fallback: string | undefined,
): string {
  return stateValue || fallback || '';
}

// Search scope is fixed to the PR's repository (state/deps only).
function readSearchCoordinates(
  meta: PrMeta | undefined,
  deps: SearchRepositoryCodeToolDependencies,
): { owner: string; repo: string } {
  return {
    owner: readPinnedCoordinate(meta?.owner, deps.defaultOwner),
    repo: readPinnedCoordinate(meta?.repo, deps.defaultRepo),
  };
}

function emptySearchResult(message: string) {
  return { totalCount: 0, items: [], message };
}

function validateSearchRequest(
  deps: SearchRepositoryCodeToolDependencies,
  owner: string,
  repo: string,
): { message: string } | { gitAdapter: GitAdapterContract } {
  if (!deps.gitAdapter) {
    return { message: 'Git adapter is not configured for code search.' };
  }
  if (!owner || !repo) {
    return { message: 'Repository owner and name are required for search.' };
  }
  return { gitAdapter: deps.gitAdapter };
}

async function searchRepositoryCode(
  gitAdapter: GitAdapterContract,
  owner: string,
  repo: string,
  query: string,
) {
  try {
    const result = await gitAdapter.searchCode(owner, repo, query);
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
    }),
    execute: async (input, ctx) => {
      const meta = ctx?.state?.get<PrMeta>(STATE.prMeta);
      const { owner, repo } = readSearchCoordinates(meta, deps);

      const validation = validateSearchRequest(deps, owner, repo);
      if ('message' in validation) {
        return emptySearchResult(validation.message);
      }

      return searchRepositoryCode(
        validation.gitAdapter,
        owner,
        repo,
        input.query,
      );
    },
  });
}
