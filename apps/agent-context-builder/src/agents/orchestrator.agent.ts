import { LlmAgent, type BaseTool } from '@google/adk';
import { z } from 'zod';

export interface ContextOrchestratorPayload {
  model: string;
  tools: {
    fetchContext: BaseTool;
    prepareRepo: BaseTool;
    summarizeChunks: BaseTool;
    synthesizeContext: BaseTool;
    storeContext: BaseTool;
  };
}

export const contextPubSubPayloadSchema = z.object({
  provider: z.string(),
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number().optional(),
  cloneUrl: z.string().optional(),
  ref: z.string().optional(),
  token: z.string().optional(),
  isIncrementalUpdate: z.boolean().optional(),
});

type ContextMode = 'baseline_update' | 'full_baseline';

function determineMode(input: any): ContextMode {
  if (input.isIncrementalUpdate) {
    return 'baseline_update';
  }
  return 'full_baseline';
}

function instruction(ctx: any): string {
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

  const mode = determineMode(input);

  switch (mode) {
    case 'baseline_update':
      return `You are the orchestrator for updating the baseline repository context document incrementally (e.g. after a PR is merged).
You MUST execute the following tools in this EXACT sequence:
1. fetch_context: Call this with provider "${input.provider}", owner "${input.owner}", and repo "${input.repo}". Wait for it to finish.
2. prepare_repository: Call this with provider "${input.provider}", owner "${input.owner}", repo "${input.repo}", prNumber ${input.prNumber}, and isIncrementalUpdate true. Wait for it to finish.
3. summarize_chunks: Summarizes the chunks concurrently. Wait for it to finish.
4. synthesize_context: Merges the new diff summaries with the existing context.
5. store_context: Sends the synthesized context back to Gateway with prNumber 0 (to overwrite the baseline). Wait for this to finish.

Return a success message as your final response.`;

    case 'full_baseline':
      return `You are the orchestrator for building a baseline repository context document from scratch.
You MUST execute the following tools in this EXACT sequence:
1. prepare_repository: Call this with provider "${input.provider}", owner "${input.owner}", repo "${input.repo}", cloneUrl "${input.cloneUrl || ''}", ref "${input.ref || ''}", and token "${input.token || ''}". Wait for it to finish.
2. summarize_chunks: Summarizes the chunks concurrently. Wait for it to finish.
3. synthesize_context: Merges all chunk summaries into a brand new structured JSON context.
4. store_context: Sends the synthesized context back to Gateway with prNumber 0 (as the baseline). Wait for this to finish.

Return a success message as your final response.`;
  }
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
    instruction,
    tools: [
      tools.fetchContext,
      tools.prepareRepo,
      tools.summarizeChunks,
      tools.synthesizeContext,
      tools.storeContext,
    ],
  });
}
