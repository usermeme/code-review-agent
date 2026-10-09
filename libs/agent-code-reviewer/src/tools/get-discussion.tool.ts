import { FunctionTool } from '@google/adk';
import { z } from 'zod';

export interface DiscussionHit {
  author?: string;
  source?: string;
  prNumber?: number;
  filePath?: string;
  body: string;
  score?: number;
}

export type DiscussionSearchFunction = (
  repo: string,
  query: string,
  limit: number,
) => Promise<DiscussionHit[]>;

export interface GetDiscussionToolDependencies {
  searchDiscussions?: DiscussionSearchFunction;
  defaultRepo?: string;
  limit?: number;
}

export function createGetDiscussionTool(
  deps: GetDiscussionToolDependencies = {},
) {
  const limit = deps.limit ?? 5;

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
          'The repository to search in (e.g. owner/repo). If not provided, relies on the Core default.',
        ),
      query: z
        .string()
        .describe(
          'Natural-language description of the finding or topic to look up',
        ),
    }),
    execute: async ({ repo: queryRepo, query }) => {
      const targetRepo = queryRepo || deps.defaultRepo || '';
      if (!deps.searchDiscussions) {
        return [];
      }

      const hits = await deps.searchDiscussions(targetRepo, query, limit);
      return hits.map((hit) => ({
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
