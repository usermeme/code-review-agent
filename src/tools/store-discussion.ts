import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import type { DiscussionStore } from '../discussions/store.js';

export function createStoreDiscussionTool(store: DiscussionStore, repo: string, prNumber: number) {
  return new FunctionTool({
    name: 'storeDiscussion',
    description:
      'Persists a note into the review-discussion memory so future reviews can find it. Use for ' +
      'noteworthy conclusions that are not covered by the findings you will publish anyway.',
    parameters: z.object({
      body: z.string().describe('The note to remember'),
      filePath: z.string().optional().describe('File the note is about, if any'),
    }),
    execute: async ({ body, filePath }) => {
      await store.insert({
        repo,
        prNumber,
        source: 'bot_finding',
        author: 'code-review-agent',
        filePath,
        body,
        createdAt: new Date(),
      });
      return { stored: true };
    },
  });
}
