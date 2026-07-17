import { FunctionTool } from '@google/adk';
import { z } from 'zod';

export function createStoreDiscussionTool(
  gatewayUrl: string,
  repo?: string,
  prNumber?: number,
) {
  return new FunctionTool({
    name: 'storeDiscussion',
    description:
      'Persists a note into the review-discussion memory so future reviews can find it. Use for ' +
      'noteworthy conclusions that are not covered by the findings you will publish anyway.',
    parameters: z.object({
      repo: z
        .string()
        .optional()
        .describe(
          'The repository to store the note for (e.g. owner/repo). If not provided, relies on the Gateway default.',
        ),
      prNumber: z
        .number()
        .optional()
        .describe(
          'The PR number to store the note for. If not provided, relies on the Gateway default.',
        ),
      body: z.string().describe('The note to remember'),
      filePath: z
        .string()
        .optional()
        .describe('File the note is about, if any'),
    }),
    execute: async ({
      repo: queryRepo,
      prNumber: queryPrNumber,
      body,
      filePath,
    }) => {
      const targetRepo = queryRepo || repo;
      const targetPrNumber = queryPrNumber || prNumber;

      const response = await fetch(`${gatewayUrl}/api/discussions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: targetRepo,
          prNumber: targetPrNumber,
          source: 'bot_finding',
          author: 'code-review-agent',
          filePath,
          body,
          createdAt: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to store discussion via gateway: ${response.statusText}`,
        );
      }

      return { stored: true };
    },
  });
}
