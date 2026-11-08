import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { RepoWorkspace } from '../workspace/repo-workspace.js';

export const grepCodeParamsSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      'Literal string or regular expression pattern to search for across repository files.',
    ),
  isRegex: z
    .boolean()
    .optional()
    .describe(
      'Set to true to treat `pattern` as a regular expression. Defaults to false (literal match).',
    ),
  caseSensitive: z
    .boolean()
    .optional()
    .describe(
      'Set to true for case-sensitive matching. Defaults to false (case-insensitive).',
    ),
  pathPattern: z
    .string()
    .optional()
    .describe(
      'Optional glob or path substring filter (e.g. "**/*.service.ts" or "src/modules/").',
    ),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe(
      'Number of surrounding context lines before and after each match (0-5, default 2).',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of matches to return (1-100, default 40).'),
});

export function createGrepCodeTool(workspace: RepoWorkspace): FunctionTool {
  return new FunctionTool({
    name: 'grep_code',
    description:
      'Search across the repository codebase using a literal string or regular expression, optionally filtered by file path or glob pattern, returning matching lines with surrounding context.',
    parameters: grepCodeParamsSchema,
    execute: async (input) => workspace.grepCode(input),
  });
}
