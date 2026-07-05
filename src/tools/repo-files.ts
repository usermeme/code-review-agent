import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { renderWithLineNumbers } from '../context/changed-files.js';
import { resolveInsideCheckout } from '../util/safe-path.js';

const execFileAsync = promisify(execFile);

const MAX_READ_LINES = 400;
const MAX_SEARCH_MATCHES = 100;

/** Core of the readFile tool, exported for direct testing. */
export async function readRepoFile(
  dir: string,
  args: { path: string; startLine?: number; endLine?: number },
): Promise<{ path: string; totalLines: number; content: string } | { error: string }> {
  const full = await resolveInsideCheckout(dir, args.path);
  if (!full) return { error: 'path escapes the repository' };
  let content: string;
  try {
    content = await readFile(full, 'utf8');
  } catch {
    return { error: `cannot read ${args.path}` };
  }
  const lines = content.split('\n');
  const start = Math.min(Math.max(1, args.startLine ?? 1), lines.length);
  const end = Math.min(lines.length, args.endLine ?? Infinity, start + MAX_READ_LINES - 1);
  return {
    path: args.path,
    totalLines: lines.length,
    content: renderWithLineNumbers(lines, { start, end }),
  };
}

/** Core of the searchRepo tool, exported for direct testing. */
export async function searchRepoFiles(
  dir: string,
  args: { pattern: string; glob?: string },
): Promise<{ matches: string[]; truncated?: boolean } | { error: string }> {
  const gitArgs = ['grep', '-n', '-I', '-E', '-e', args.pattern];
  if (args.glob) gitArgs.push('--', args.glob);
  try {
    const { stdout } = await execFileAsync('git', gitArgs, {
      cwd: dir,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const matches = stdout.split('\n').filter(Boolean);
    return {
      matches: matches.slice(0, MAX_SEARCH_MATCHES),
      ...(matches.length > MAX_SEARCH_MATCHES ? { truncated: true } : {}),
    };
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { code?: number | string }).code === 1) return { matches: [] };
    return {
      error: `search failed: ${(error as Error).message?.split('\n')[0] ?? 'unknown'}`,
    };
  }
}

export function createReadFileTool(dir: string) {
  return new FunctionTool({
    name: 'readFile',
    description:
      'Reads a file from the PR head checkout with 1-based line numbers (max ' +
      `${MAX_READ_LINES} lines per call). Use it to inspect code surrounding a hunk or a ` +
      'function the change interacts with, before deciding whether a finding is real.',
    parameters: z.object({
      path: z.string().describe('Repo-relative file path'),
      startLine: z.number().int().positive().optional().describe('First line to read (default 1)'),
      endLine: z.number().int().positive().optional().describe('Last line to read'),
    }),
    execute: ({ path, startLine, endLine }) => readRepoFile(dir, { path, startLine, endLine }),
  });
}

export function createSearchRepoTool(dir: string) {
  return new FunctionTool({
    name: 'searchRepo',
    description:
      'Regex search (POSIX extended, git grep) across the PR head checkout. Use it to find ' +
      'callers of a changed function, existing utilities, or duplicated patterns. Returns ' +
      '"path:line:text" matches.',
    parameters: z.object({
      pattern: z.string().describe('Regular expression to search for'),
      glob: z.string().optional().describe("Limit to paths matching this pathspec, e.g. 'src/**/*.ts'"),
    }),
    execute: ({ pattern, glob }) => searchRepoFiles(dir, { pattern, glob }),
  });
}
