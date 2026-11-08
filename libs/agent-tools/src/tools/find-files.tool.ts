import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { RepoWorkspace } from '../workspace/repo-workspace.js';

export const findFilesParamsSchema = z.object({
  pattern: z
    .string()
    .optional()
    .describe(
      'Optional glob pattern (e.g. "**/*.spec.ts", "apps/core/**") or path substring to filter files. Omit to list repository files.',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Maximum number of file paths to return (1-500, default 200).'),
});

export function createFindFilesTool(workspace: RepoWorkspace): FunctionTool {
  return new FunctionTool({
    name: 'find_files',
    description:
      'List or search file paths in the repository using a glob pattern or substring.',
    parameters: findFilesParamsSchema,
    execute: async (input) => workspace.findFiles(input),
  });
}
