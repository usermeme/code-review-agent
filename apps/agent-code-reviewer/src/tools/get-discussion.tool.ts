import { FunctionTool } from '@google/adk';
import { z } from 'zod';

export function createGetDiscussionTool(
  gatewayUrl: string,
  repo?: string,
  limit: number = 5,
) {
  return new FunctionTool({
    name: 'getDiscussion',
    description:
      'Semantic search over past review discussions in this repository (human PR comments, review ' +
      'threads, and previously posted bot findings). Use it to check whether the team has already ' +
      'discussed, accepted, or rejected feedback similar to a candidate finding.',
    parameters: z.object({
      repo: z
        .string()
        .optional()
        .describe(
          'The repository to search in (e.g. owner/repo). If not provided, relies on the Gateway default.',
        ),
      query: z
        .string()
        .describe(
          'Natural-language description of the finding or topic to look up',
        ),
    }),
    execute: async ({ repo: queryRepo, query }) => {
      const targetRepo = queryRepo || repo;
      const response = await fetch(
        `${gatewayUrl}/api/discussions/search?repo=${encodeURIComponent(targetRepo || '')}&query=${encodeURIComponent(query)}&limit=${limit}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to search discussions from gateway: ${response.statusText}`,
        );
      }

      const hits = await response.json();
      return hits.map((hit: any) => ({
        author: hit.author,
        source: hit.source,
        prNumber: hit.prNumber,
        filePath: hit.filePath,
        body: (hit.body || '').slice(0, 600),
        score: Number(hit.score?.toFixed(3) || 0),
      }));
    },
  });
}
