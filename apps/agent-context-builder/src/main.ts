import { createContextOrchestrator } from './agents/orchestrator.agent.js';
import { createPrepareRepoTool } from './tools/prepare-repo.tool.js';
import { createStoreContextTool } from './tools/store-context.tool.js';
import { createSummarizeRepoTool } from './tools/summarize-chunks.tool.js';
import { createSynthesizeContextTool } from './tools/synthesize-context.tool.js';

// 1. Fetch the required environment variable config at initialization
const gatewayUrl = process.env.GATEWAY_URL;
if (!gatewayUrl) {
  throw new Error('GATEWAY_URL environment variable is required');
}

const reviewModel = process.env.REVIEW_MODEL ?? 'gemini-3.1-pro';

// 2. Setup the tools
const tools = {
  prepareRepo: createPrepareRepoTool(),
  summarizeChunks: createSummarizeRepoTool(reviewModel),
  synthesizeContext: createSynthesizeContextTool(reviewModel),
  storeContext: createStoreContextTool(gatewayUrl),
};

// 3. Export the Orchestrator LlmAgent instance.
export const contextBuilderAgent = createContextOrchestrator({
  model: reviewModel,
  tools,
});
