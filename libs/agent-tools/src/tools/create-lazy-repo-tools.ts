import { FunctionTool } from '@google/adk';

import type { RepoWorkspace } from '../workspace/repo-workspace.js';
import { findFilesParamsSchema } from './find-files.tool.js';
import { grepCodeParamsSchema } from './grep-code.tool.js';
import { readFileParamsSchema } from './read-file.tool.js';

export interface LazyRepoTools {
  all: FunctionTool[];
  /** True once a tool call triggered the repository download. */
  loaded(): boolean;
}

type WorkspaceCall<Result> = (workspace: RepoWorkspace) => Result;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `read_file`, `grep_code` and `find_files` over a repository that is only
 * downloaded when one of them is first called. An agent that settles its
 * task from the prompt alone never pays for the tarball.
 */
export function createLazyRepoTools(
  loadWorkspace: () => Promise<RepoWorkspace>,
): LazyRepoTools {
  let pending: Promise<RepoWorkspace> | undefined;
  const withWorkspace = async <Result>(call: WorkspaceCall<Result>) => {
    pending ??= loadWorkspace();
    try {
      return call(await pending);
    } catch (error) {
      return { error: `Repository unavailable: ${describeError(error)}` };
    }
  };

  const readFile = new FunctionTool({
    name: 'read_file',
    description:
      'Read lines from a file in the repository at the PR head, with 1-based line numbers prefixed.',
    parameters: readFileParamsSchema,
    execute: (input) => withWorkspace((ws) => ws.readFile(input)),
  });
  const grepCode = new FunctionTool({
    name: 'grep_code',
    description:
      'Search the repository at the PR head with a literal string or regular expression, optionally filtered by path or glob.',
    parameters: grepCodeParamsSchema,
    execute: (input) => withWorkspace((ws) => ws.grepCode(input)),
  });
  const findFiles = new FunctionTool({
    name: 'find_files',
    description:
      'List or search file paths in the repository at the PR head using a glob pattern or substring.',
    parameters: findFilesParamsSchema,
    execute: (input) => withWorkspace((ws) => ws.findFiles(input)),
  });

  return {
    all: [readFile, grepCode, findFiles],
    loaded: () => pending !== undefined,
  };
}
