import { LlmAgent, type BaseTool } from '@google/adk';
import { z } from 'zod';

export interface ContextOrchestratorPayload {
  model: string;
  tools: {
    prepareRepo: BaseTool;
    summarizeChunks: BaseTool;
    synthesizeContext: BaseTool;
    storeContext: BaseTool;
  };
}

export const contextPubSubPayloadSchema = z.object({
  repo: z.string(),
  ref: z.string(),
  cloneUrl: z.string(),
  token: z.string().optional(),
});

function getInstruction() {
  return (ctx: any) => {
    // Extract payload from ADK's Pub/Sub ingress structure
    let input: any = {};
    const text = ctx.userContent?.parts?.[0]?.text;
    if (text) {
      try {
        input = JSON.parse(text);
      } catch {
        // Ignore parsing errors, fallback to empty
      }
    }

    return `You are the orchestrator for building a repository context document.
When you receive a repository build request, you MUST execute the following tools in this EXACT sequence:
1. prepare_repository: Call this with repo "${input.repo}", ref "${input.ref}", cloneUrl "${input.cloneUrl}", and token "${input.token || ''}". Wait for it to finish.
2. summarize_chunks: Summarizes the chunks concurrently. Wait for it to finish.
3. synthesize_context: Merges the summaries into a final structured JSON context.
4. store_context: Sends the synthesized sections back to the Gateway to be saved. Wait for this to finish.

Return a success message as your final response.
Do not invent any information. Only use the tools provided.`;
  };
}

export function createContextOrchestrator({
  model,
  tools,
}: ContextOrchestratorPayload): LlmAgent {
  return new LlmAgent({
    name: 'context_builder_orchestrator',
    description: 'Coordinates the repository context building process.',
    model,
    inputSchema: contextPubSubPayloadSchema,
    instruction: getInstruction(),
    tools: [
      tools.prepareRepo,
      tools.summarizeChunks,
      tools.synthesizeContext,
      tools.storeContext,
    ],
  });
}
