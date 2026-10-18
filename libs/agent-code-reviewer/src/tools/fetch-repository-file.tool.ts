import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { type PrMeta, STATE } from '../constants/state-keys.constant.js';
import { isIgnoredDiffPath } from '../utils/diff.util.js';
import {
  fetchCachedRepoFile,
  readPinnedCoordinates,
  type RepoToolDependencies,
} from './repo-tool-context.util.js';

const MAX_LINES = 250;
const MAX_CHARACTERS = 15_000;

export type FetchRepositoryFileToolDependencies = RepoToolDependencies;

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
  const { owner, repo, ref: defaultRef } = readPinnedCoordinates(meta, deps);
  if (!isDisallowedRef(meta, requestedRef)) {
    return {
      owner,
      repo,
      ref: requestedRef || defaultRef,
      refNotice: undefined,
    };
  }
  return {
    owner,
    repo,
    ref: defaultRef,
    refNotice: `Requested ref '${requestedRef}' is not this PR's head/base branch; the file was read from '${defaultRef}'.`,
  };
}

function validateFetchRequest(
  deps: FetchRepositoryFileToolDependencies,
  owner: string,
  repo: string,
  path: string,
): { error: string } | { gitAdapter: GitAdapterContract } {
  if (isIgnoredDiffPath(path)) {
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
  try {
    const rawContent = await fetchCachedRepoFile(
      {
        gitAdapter,
        fileCache,
        owner: target.owner,
        repo: target.repo,
        ref: target.ref,
      },
      path,
    );
    return { rawContent };
  } catch (err) {
    return {
      error: `Failed to fetch file '${path}': ${String(err)}`,
    };
  }
}

function resolveLineWindow(
  totalLines: number,
  startLine = 1,
  endLine = totalLines,
): LineWindow {
  const maxLine = Math.max(1, totalLines);
  const start = Math.min(maxLine, Math.max(1, startLine));
  const cappedEnd = Math.min(maxLine, endLine, start + MAX_LINES - 1);
  return { start, end: Math.max(start, cappedEnd) };
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
