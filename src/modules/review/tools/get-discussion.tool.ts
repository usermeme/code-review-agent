import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import type { DiscussionStore } from '../../discussion/store.service.js';

export function createGetDiscussionTool(store: DiscussionStore, repo: string, limit: number) {
  return new FunctionTool({
    name: 'getDiscussion',
    description:
      'Semantic search over past review discussions in this repository (human PR comments, review ' +
      'threads, and previously posted bot findings). Use it to check whether the team has already ' +
      'discussed, accepted, or rejected feedback similar to a candidate finding.',
    parameters: z.object({
      query: z.string().describe('Natural-language description of the finding or topic to look up'),
    }),
    execute: async ({ query }) => {
      const hits = await store.search(repo, query, limit);
      return hits.map((hit) => ({
        author: hit.author,
        source: hit.source,
        prNumber: hit.prNumber,
        filePath: hit.filePath,
        body: hit.body.slice(0, 600),
        score: Number(hit.score.toFixed(3)),
      }));
    },
  });
}
