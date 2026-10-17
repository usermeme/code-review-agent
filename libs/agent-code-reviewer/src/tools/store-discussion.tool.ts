import { FunctionTool } from '@google/adk';
import { z } from 'zod';

export interface StoreDiscussionInput {
  repo: string;
  prNumber?: number;
  source: string;
  author: string;
  filePath?: string;
  body: string;
  createdAt: string;
}

export type DiscussionStoreFunction = (
  input: StoreDiscussionInput,
) => Promise<boolean>;

export interface StoreDiscussionToolDependencies {
  storeDiscussion?: DiscussionStoreFunction;
  defaultRepo?: string;
  defaultPrNumber?: number;
}

export function createStoreDiscussionTool(
  deps: StoreDiscussionToolDependencies = {},
) {
  return new FunctionTool({
    name: 'storeDiscussion',
    description:
      'Persists a note into the review-discussion memory so future reviews can find it. Use for ' +
      'noteworthy conclusions that are not covered by the findings you will publish anyway.',
    parameters: z.object({
      body: z.string().describe('The note to remember'),
      filePath: z
        .string()
        .optional()
        .describe('File the note is about, if any'),
    }),
    execute: async ({ body, filePath }) => {
      // The target repo/PR are fixed to the review defaults — the model
      // cannot redirect writes to another repository or PR number.
      const targetRepo = deps.defaultRepo || '';
      const targetPrNumber = deps.defaultPrNumber;

      if (!deps.storeDiscussion) {
        return { stored: false };
      }

      const stored = await deps.storeDiscussion({
        repo: targetRepo,
        prNumber: targetPrNumber,
        source: 'bot_finding',
        author: 'code-review-agent',
        filePath,
        body,
        createdAt: new Date().toISOString(),
      });

      return { stored };
    },
  });
}
