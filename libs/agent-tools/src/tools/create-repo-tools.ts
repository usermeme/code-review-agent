import { FunctionTool } from '@google/adk';

import { RepoWorkspace } from '../workspace/repo-workspace.js';
import { createFindFilesTool } from './find-files.tool.js';
import { createGetPrDiffTool } from './get-pr-diff.tool.js';
import { createGrepCodeTool } from './grep-code.tool.js';
import { createReadFileTool } from './read-file.tool.js';

export interface RepoAgentTools {
  grepCode: FunctionTool;
  readFile: FunctionTool;
  findFiles: FunctionTool;
  getPrDiff: FunctionTool;
  all: FunctionTool[];
}

export function createRepoTools(workspace: RepoWorkspace): RepoAgentTools {
  const grepCode = createGrepCodeTool(workspace);
  const readFile = createReadFileTool(workspace);
  const findFiles = createFindFilesTool(workspace);
  const getPrDiff = createGetPrDiffTool(workspace);

  return {
    grepCode,
    readFile,
    findFiles,
    getPrDiff,
    all: [grepCode, readFile, findFiles, getPrDiff],
  };
}
