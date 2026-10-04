import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { PubSub } from '@google-cloud/pubsub';
import { Env } from 'env';

export function createStoreContextTool() {
  const pubsub = new PubSub();
  const env = new Env(
    z.object({
      CONTEXT_READY_TOPIC: z.string().min(1),
    }),
  );
  const topicName = env.get('CONTEXT_READY_TOPIC');

  return new FunctionTool({
    name: 'store_context',
    description:
      'Stores the synthesized context by sending it to the Gateway via Pub/Sub.',
    parameters: z.object({
      provider: z.string(),
      owner: z.string(),
      repo: z.string(),
      prNumber: z.number().nullable().optional(),
      sections: z.record(z.string(), z.string()),
    }),
    execute: async (input) => {
      const payload = {
        provider: input.provider,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber || 0, // 0 for repository baseline
        summary: JSON.stringify(input.sections),
      };

      await pubsub.topic(topicName).publishMessage({
        json: payload,
      });

      return 'Context successfully published to Pub/Sub.';
    },
  });
}
