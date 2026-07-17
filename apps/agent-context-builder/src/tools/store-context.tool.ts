import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { STATE } from '../constants/state-keys.constant.js';

export function createStoreContextTool(gatewayUrl: string) {
  return new FunctionTool({
    name: 'store_context',
    description: 'Stores the synthesized context by sending it to the Gateway.',
    parameters: z.object({
      repo: z.string(),
      headSha: z.string().optional(),
      sections: z.record(z.string(), z.string()),
    }),
    execute: async (input, ctx) => {
      const response = await fetch(`${gatewayUrl}/v1/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: input.repo,
          headSha: input.headSha || ctx.state[STATE.headSha],
          sections: input.sections,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to store context. Gateway returned: ${response.status} ${response.statusText}`);
      }

      return 'Context successfully stored.';
    },
  });
}
