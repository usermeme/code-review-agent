import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { type PrMeta, STATE } from '../constants/state-keys.constant.js';
import { isIgnoredDiffPath } from '../utils/diff.util.js';

const BLOCKED_FILE_EXTENSIONS = [
  '.lock',
  '-lock.json',
  '.min.js',
  '.min.css',
  '.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.tar',
  '.gz',
  '.zip',
];

const MAX_LINES = 250;
const MAX_CHARACTERS = 15_000;

export interface FetchRepositoryFileToolDependencies {
  gitAdapter?: GitAdapterContract;
  defaultOwner?: string;
  defaultRepo?: string;
  cache?: Map<string, string>;
}

/** Where the file is read from: pinned coordinates plus the (clamped) ref. */
interface FileFetchTarget {
  owner: string;
  repo: string;
  ref: string | undefined;
  refNotice: string | undefined;
}

interface LineWindow {
  start: number;
  end: number;
}

type RawFileFetchOutcome = { rawContent: string } | { error: string };

function readPinnedCoordinate(
  stateValue: string | undefined,
  fallback: string | undefined,
): string {
  return stateValue || fallback || '';
}

// Coordinates are fixed to the PR under review: model-supplied
// owner/repo are no longer accepted, and state/deps are the only
// sources. This blocks prompt-injected cross-repo reads.
function readRepositoryCoordinates(
  meta: PrMeta | undefined,
  deps: FetchRepositoryFileToolDependencies,
): { owner: string; repo: string } {
  return {
    owner: readPinnedCoordinate(meta?.owner, deps.defaultOwner),
    repo: readPinnedCoordinate(meta?.repo, deps.defaultRepo),
  };
}

function readDefaultRef(meta: PrMeta | undefined): string | undefined {
  return meta?.branch || meta?.headSha || undefined;
}

function listAllowedRefs(meta: PrMeta | undefined): string[] {
  return [meta?.branch, meta?.baseRef, meta?.headSha].filter((r): r is string =>
    Boolean(r),
  );
}

function isDisallowedRef(
  meta: PrMeta | undefined,
  requestedRef: string | undefined,
): boolean {
  const allowedRefs = listAllowedRefs(meta);
  return Boolean(
    meta &&
    requestedRef &&
    allowedRefs.length > 0 &&
    !allowedRefs.includes(requestedRef),
  );
}

// Clamp ref to the PR's own head/base refs (or head SHA); anything
// else silently falls back to the head branch/SHA with a notice.
function resolveFetchTarget(
  meta: PrMeta | undefined,
  deps: FetchRepositoryFileToolDependencies,
  requestedRef: string | undefined,
): FileFetchTarget {
  const coordinates = readRepositoryCoordinates(meta, deps);
  const defaultRef = readDefaultRef(meta);
  if (!isDisallowedRef(meta, requestedRef)) {
    return {
      ...coordinates,
      ref: requestedRef || defaultRef,
      refNotice: undefined,
    };
  }
  const ref = defaultRef;
  return {
    ...coordinates,
    ref,
    refNotice: `Requested ref '${requestedRef}' is not this PR's head/base branch; the file was read from '${ref}'.`,
  };
}

function isBlockedFilePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return (
    BLOCKED_FILE_EXTENSIONS.some((ext) => lowerPath.endsWith(ext)) ||
    isIgnoredDiffPath(path)
  );
}

function validateFetchRequest(
  deps: FetchRepositoryFileToolDependencies,
  owner: string,
  repo: string,
  path: string,
): { error: string } | { gitAdapter: GitAdapterContract } {
  if (isBlockedFilePath(path)) {
    return {
      error: `File path '${path}' matches blocked extensions (lockfiles, minified files, or binary assets).`,
    };
  }
  if (!deps.gitAdapter) {
    return {
      error: 'Git adapter is not configured for file retrieval.',
    };
  }
  if (!owner || !repo) {
    return {
      error: 'Repository owner and name are required.',
    };
  }
  return { gitAdapter: deps.gitAdapter };
}

async function fetchRawFileContent(
  gitAdapter: GitAdapterContract,
  fileCache: Map<string, string>,
  target: FileFetchTarget,
  path: string,
): Promise<RawFileFetchOutcome> {
  const cacheKey = `${target.owner}:${target.repo}:${target.ref || 'default'}:${path}`;
  const cachedContent = fileCache.get(cacheKey);
  if (cachedContent) {
    return { rawContent: cachedContent };
  }
  try {
    const fileResult = await gitAdapter.getFileContent(
      target.owner,
      target.repo,
      path,
      target.ref,
    );
    fileCache.set(cacheKey, fileResult.content);
    return { rawContent: fileResult.content };
  } catch (err) {
    return {
      error: `Failed to fetch file '${path}': ${String(err)}`,
    };
  }
}

function resolveLineWindow(
  totalLines: number,
  startLine: number | undefined,
  endLine: number | undefined,
): LineWindow {
  const start = startLine ? Math.max(1, startLine) : 1;
  let end = endLine
    ? Math.min(totalLines, endLine)
    : Math.min(totalLines, start + MAX_LINES - 1);

  if (end < start) {
    end = start;
  }
  if (end - start + 1 > MAX_LINES) {
    end = start + MAX_LINES - 1;
  }
  return { start, end };
}

function capContentCharacters(content: string): string {
  if (content.length > MAX_CHARACTERS) {
    return (
      content.slice(0, MAX_CHARACTERS) +
      '\n[Content truncated due to size limit]'
    );
  }
  return content;
}

function buildFileWindowContent(
  allLines: string[],
  window: LineWindow,
  totalLines: number,
  requestedEndLine: number | undefined,
): string {
  const slicedLines = allLines.slice(window.start - 1, window.end);
  const numberedContent = slicedLines
    .map((line, idx) => `${window.start + idx}: ${line}`)
    .join('\n');

  let truncatedWarning = '';
  if (window.end < totalLines && !requestedEndLine) {
    truncatedWarning = `\n[Note: showing lines ${window.start}-${window.end} of ${totalLines}. Specify startLine and endLine to inspect other sections.]`;
  }

  return capContentCharacters(numberedContent + truncatedWarning);
}

function buildFileFetchResult(
  path: string,
  rawContent: string,
  requestedStartLine: number | undefined,
  requestedEndLine: number | undefined,
  refNotice: string | undefined,
) {
  const allLines = rawContent.split('\n');
  const totalLines = allLines.length;
  const window = resolveLineWindow(
    totalLines,
    requestedStartLine,
    requestedEndLine,
  );
  const finalContent = buildFileWindowContent(
    allLines,
    window,
    totalLines,
    requestedEndLine,
  );

  return {
    path,
    startLine: window.start,
    endLine: window.end,
    totalLines,
    ...(refNotice ? { refNotice } : {}),
    content: `<UNTRUSTED_REPOSITORY_FILE path="${path}">\n${finalContent}\n</UNTRUSTED_REPOSITORY_FILE>`,
  };
}

export function createFetchRepositoryFileTool(
  deps: FetchRepositoryFileToolDependencies = {},
) {
  const fileCache = deps.cache ?? new Map<string, string>();

  return new FunctionTool({
    name: 'fetchRepositoryFile',
    description:
      'Fetches file content from the repository under review (owner/repo are fixed). Use this to inspect callers, types, existing utilities, or surrounding code. Maximum 250 lines returned at a time.',
    parameters: z.object({
      path: z
        .string()
        .describe(
          'Repository-relative file path (e.g. src/auth/auth.service.ts)',
        ),
      startLine: z
        .number()
        .optional()
        .describe('1-based starting line number (optional)'),
      endLine: z
        .number()
        .optional()
        .describe('1-based ending line number (optional)'),
      ref: z
        .string()
        .optional()
        .describe(
          'Optional git ref to read the file at — only the PR head/base branch or its commit SHA are allowed; anything else falls back to the PR head branch.',
        ),
    }),
    execute: async (input, ctx) => {
      const meta = ctx?.state?.get<PrMeta>(STATE.prMeta);
      const target = resolveFetchTarget(meta, deps, input.ref);

      const validation = validateFetchRequest(
        deps,
        target.owner,
        target.repo,
        input.path,
      );
      if ('error' in validation) {
        return validation;
      }

      const outcome = await fetchRawFileContent(
        validation.gitAdapter,
        fileCache,
        target,
        input.path,
      );
      if ('error' in outcome) {
        return outcome;
      }

      return buildFileFetchResult(
        input.path,
        outcome.rawContent,
        input.startLine,
        input.endLine,
        target.refNotice,
      );
    },
  });
}
