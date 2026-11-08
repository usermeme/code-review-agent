import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { RepoWorkspace } from '../workspace/repo-workspace.js';

export const readFileParamsSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Repository-relative file path to read (e.g. "src/services/user.service.ts").',
    ),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based starting line number to read from (defaults to 1).'),
  endLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      '1-based inclusive ending line number (capped at 250 lines per call; defaults to startLine + 199).',
    ),
});

export function createReadFileTool(workspace: RepoWorkspace): FunctionTool {
  return new FunctionTool({
    name: 'read_file',
    description:
      'Read lines from a file in the repository with 1-based line numbers prefixed. Use startLine and endLine to inspect specific sections.',
    parameters: readFileParamsSchema,
    execute: async (input) => workspace.readFile(input),
  });
}
