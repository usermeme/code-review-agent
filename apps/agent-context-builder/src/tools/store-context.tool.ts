import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { PubSub } from '@google-cloud/pubsub';

export function createStoreContextTool() {
  const pubsub = new PubSub();
  const topicName = process.env.CONTEXT_READY_TOPIC || 'context-ready-topic';

  return new FunctionTool({
    name: 'store_context',
    description: 'Stores the synthesized context by sending it to the Gateway via Pub/Sub.',
    parameters: z.object({
      provider: z.string(),
      owner: z.string(),
      repo: z.string(),
      prNumber: z.number().nullable().optional(),
      sections: z.record(z.string(), z.string()),
    }),
    execute: async (input) => {
      // The Gateway expects `files` and `summary`. We serialize sections into summary.
      // And we send an empty `files` object because the actual context is in `summary`.
      const payload = {
        provider: input.provider,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber || 0, // 0 for repository baseline
        files: {},
        summary: JSON.stringify(input.sections),
      };

      await pubsub.topic(topicName).publishMessage({
        json: payload,
      });

      return 'Context successfully published to Pub/Sub.';
    },
  });
}
