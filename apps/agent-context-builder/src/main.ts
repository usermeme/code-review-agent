import { z } from 'zod';
import { Env } from 'env';
import { createContextOrchestrator } from './agents/orchestrator.agent.js';
import { createPrepareRepoTool } from './tools/prepare-repo.tool.js';
import { createStoreContextTool } from './tools/store-context.tool.js';
import { createSummarizeRepoTool } from './tools/summarize-chunks.tool.js';
import { createSynthesizeContextTool } from './tools/synthesize-context.tool.js';
import { createFetchContextTool } from './tools/fetch-context.tool.js';

const env = new Env(
  z.object({
    CORE_URL: z.string().min(1),
    REVIEW_MODEL: z.string().min(1),
  }),
);

const coreUrl = env.get('CORE_URL');
const reviewModel = env.get('REVIEW_MODEL');

// 2. Setup the tools
const tools = {
  fetchContext: createFetchContextTool(coreUrl),
  prepareRepo: createPrepareRepoTool(),
  summarizeChunks: createSummarizeRepoTool({ model: reviewModel }),
  synthesizeContext: createSynthesizeContextTool({ model: reviewModel }),
  storeContext: createStoreContextTool(),
};

// 3. Export the Orchestrator LlmAgent instance.
export const contextBuilderAgent = createContextOrchestrator({
  model: reviewModel,
  tools,
});
export const rootAgent = contextBuilderAgent;
export default contextBuilderAgent;
