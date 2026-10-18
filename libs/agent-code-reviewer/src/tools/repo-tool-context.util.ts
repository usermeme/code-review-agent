import type { GitAdapterContract } from '@code-review-agent/shared-types';

import type { PrMeta } from '../constants/state-keys.constant.js';

export interface RepoToolDependencies {
  gitAdapter?: GitAdapterContract;
  defaultOwner?: string;
  defaultRepo?: string;
  cache?: Map<string, string>;
}

export interface RepoFileFetcher {
  gitAdapter: GitAdapterContract;
  fileCache: Map<string, string>;
  owner: string;
  repo: string;
  ref: string | undefined;
}

export function readPinnedRef(meta: PrMeta | undefined): string | undefined {
  return meta?.branch || meta?.headSha || undefined;
}

function resolveCoordinate(
  pinned: string | undefined,
  fallback: string | undefined,
): string {
  return pinned || fallback || '';
}

export function readPinnedCoordinates(
  meta: PrMeta | undefined,
  deps: RepoToolDependencies,
): { owner: string; repo: string; ref: string | undefined } {
  return {
    owner: resolveCoordinate(meta?.owner, deps.defaultOwner),
    repo: resolveCoordinate(meta?.repo, deps.defaultRepo),
    ref: readPinnedRef(meta),
  };
}

export async function fetchCachedRepoFile(
  fetcher: RepoFileFetcher,
  path: string,
): Promise<string> {
  const cacheKey = `${fetcher.owner}:${fetcher.repo}:${fetcher.ref || 'default'}:${path}`;
  const cached = fetcher.fileCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const res = await fetcher.gitAdapter.getFileContent(
    fetcher.owner,
    fetcher.repo,
    path,
    fetcher.ref,
  );
  const content = res?.content ?? '';
  fetcher.fileCache.set(cacheKey, content);
  return content;
}
