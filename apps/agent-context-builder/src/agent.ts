import { createContextOrchestrator } from './agents/orchestrator.agent.js';
import { createPrepareRepoTool } from './tools/prepare-repo.tool.js';
import { createStoreContextTool } from './tools/store-context.tool.js';
import { createSummarizeRepoTool } from './tools/summarize-chunks.tool.js';
import { createSynthesizeContextTool } from './tools/synthesize-context.tool.js';
import { createFetchContextTool } from './tools/fetch-context.tool.js';
import type { ContextBuilderEnvService } from './env.js';
import type { LlmAgent } from '@google/adk';

export function createContextBuilderAgent(
  envService: ContextBuilderEnvService,
): LlmAgent {
  const coreUrl = envService.get('CORE_URL');
  const reviewModel = envService.get('REVIEW_MODEL');

  const tools = {
    fetchContext: createFetchContextTool(coreUrl),
    prepareRepo: createPrepareRepoTool({ envService }),
    summarizeChunks: createSummarizeRepoTool({ model: reviewModel }),
    synthesizeContext: createSynthesizeContextTool({ model: reviewModel }),
    storeContext: createStoreContextTool({ envService }),
  };

  return createContextOrchestrator({
    model: reviewModel,
    tools,
  });
}
