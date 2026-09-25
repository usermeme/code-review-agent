import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { STATE } from '../constants/state-keys.constant.js';

export function createFetchContextTool(gatewayUrl: string) {
  return new FunctionTool({
    name: 'fetch_context',
    description:
      'Fetches the existing baseline repository context from the Gateway.',
    parameters: z.object({
      provider: z.string(),
      owner: z.string(),
      repo: z.string(),
    }),
    execute: async (input, ctx) => {
      // The baseline context is stored as prNumber 0
      const repoKey = `${input.provider}:${input.owner}:${input.repo}:0`;

      try {
        const response = await fetch(`${gatewayUrl}/api/v1/context/${repoKey}`);

        if (!response.ok) {
          if (response.status === 404) {
            ctx.state[STATE.existingContext] = null;
            return `No existing context found for ${repoKey}.`;
          }
          throw new Error(`Gateway returned status: ${response.status}`);
        }

        const data = await response.json();

        let parsedSections: Record<string, string> = {};
        if (data.summary) {
          try {
            parsedSections = JSON.parse(data.summary);
          } catch {
            parsedSections = { architecture: data.summary };
          }
        }

        ctx.state[STATE.existingContext] = parsedSections;
        return `Successfully fetched existing context. Keys found: ${Object.keys(parsedSections).join(', ')}`;
      } catch (error) {
        throw new Error(`Failed to fetch context: ${error}`, { cause: error });
      }
    },
  });
}
