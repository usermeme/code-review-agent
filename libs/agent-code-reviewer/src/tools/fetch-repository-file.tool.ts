import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { STATE } from '../constants/state-keys.constant.js';
import type { GitAdapterContract } from 'shared-types';

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
      'Fetches file content from the repository. Use this to inspect callers, types, existing utilities, or surrounding code. Maximum 250 lines returned at a time.',
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
          'Git ref, commit SHA, or branch (defaults to base or target branch)',
        ),
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
    }),
    execute: async (input, ctx) => {
      const meta = ctx?.state?.get<Record<string, any>>(STATE.prMeta);
      const owner = input.owner || meta?.['owner'] || deps.defaultOwner || '';
      const repo = input.repo || meta?.['repo'] || deps.defaultRepo || '';
      const ref = input.ref || meta?.['branch'];

      const lowerPath = input.path.toLowerCase();
      if (BLOCKED_FILE_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) {
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
        content: `<UNTRUSTED_REPOSITORY_FILE path="${input.path}">\n${finalContent}\n</UNTRUSTED_REPOSITORY_FILE>`,
      };
    },
  });
}
