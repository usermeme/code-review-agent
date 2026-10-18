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
      // Coordinates are fixed to the PR under review: model-supplied
      // owner/repo are no longer accepted, and state/deps are the only
      // sources. This blocks prompt-injected cross-repo reads.
      const owner = meta?.owner || deps.defaultOwner || '';
      const repo = meta?.repo || deps.defaultRepo || '';

      // Clamp ref to the PR's own head/base refs (or head SHA); anything
      // else silently falls back to the head branch/SHA with a notice.
      const defaultRef = meta?.branch || meta?.headSha || undefined;
      let ref = input.ref || defaultRef;
      let refNotice: string | undefined;
      const allowedRefs = [meta?.branch, meta?.baseRef, meta?.headSha].filter(
        (r): r is string => Boolean(r),
      );
      if (
        meta &&
        input.ref &&
        allowedRefs.length > 0 &&
        !allowedRefs.includes(input.ref)
      ) {
        ref = defaultRef;
        refNotice = `Requested ref '${input.ref}' is not this PR's head/base branch; the file was read from '${ref}'.`;
      }

      const lowerPath = input.path.toLowerCase();
      if (
        BLOCKED_FILE_EXTENSIONS.some((ext) => lowerPath.endsWith(ext)) ||
        isIgnoredDiffPath(input.path)
      ) {
        return {
          error: `File path '${input.path}' matches blocked extensions (lockfiles, minified files, or binary assets).`,
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

      const cacheKey = `${owner}:${repo}:${ref || 'default'}:${input.path}`;
      let rawContent = fileCache.get(cacheKey);

      if (!rawContent) {
        try {
          const fileResult = await deps.gitAdapter.getFileContent(
            owner,
            repo,
            input.path,
            ref,
          );
          rawContent = fileResult.content;
          fileCache.set(cacheKey, rawContent);
        } catch (err) {
          return {
            error: `Failed to fetch file '${input.path}': ${String(err)}`,
          };
        }
      }

      const allLines = rawContent.split('\n');
      const totalLines = allLines.length;

      const start = input.startLine ? Math.max(1, input.startLine) : 1;
      let end = input.endLine
        ? Math.min(totalLines, input.endLine)
        : Math.min(totalLines, start + MAX_LINES - 1);

      if (end < start) {
        end = start;
      }
      if (end - start + 1 > MAX_LINES) {
        end = start + MAX_LINES - 1;
      }

      const slicedLines = allLines.slice(start - 1, end);
      const numberedContent = slicedLines
        .map((line, idx) => `${start + idx}: ${line}`)
        .join('\n');

      let truncatedWarning = '';
      if (end < totalLines && !input.endLine) {
        truncatedWarning = `\n[Note: showing lines ${start}-${end} of ${totalLines}. Specify startLine and endLine to inspect other sections.]`;
      }

      let finalContent = numberedContent + truncatedWarning;
      if (finalContent.length > MAX_CHARACTERS) {
        finalContent =
          finalContent.slice(0, MAX_CHARACTERS) +
          '\n[Content truncated due to size limit]';
      }

      return {
        path: input.path,
        startLine: start,
        endLine: end,
        totalLines,
        ...(refNotice ? { refNotice } : {}),
        content: `<UNTRUSTED_REPOSITORY_FILE path="${input.path}">\n${finalContent}\n</UNTRUSTED_REPOSITORY_FILE>`,
      };
    },
  });
}
