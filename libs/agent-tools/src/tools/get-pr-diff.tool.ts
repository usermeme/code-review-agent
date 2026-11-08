import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { RepoWorkspace } from '../workspace/repo-workspace.js';

export const getPrDiffParamsSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      'Optional repository-relative file path to get the unified diff for a single changed file. Omit to get the overall PR diff and changedFiles list.',
    ),
});

export function createGetPrDiffTool(workspace: RepoWorkspace): FunctionTool {
  return new FunctionTool({
    name: 'get_pr_diff',
    description:
      'Inspect the pull request unified diff and list of changed files, optionally filtered to a single file path.',
    parameters: getPrDiffParamsSchema,
    execute: async (input) => workspace.getPrDiff(input),
  });
}
