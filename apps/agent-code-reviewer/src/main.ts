import { createOrchestrator } from './agents/orchestrator.agent.js';
import { createGetRepoContextTool } from './tools/get-repo-context.tool.js';
import { createGetDiscussionTool } from './tools/get-discussion.tool.js';
import { createStoreDiscussionTool } from './tools/store-discussion.tool.js';
import { createPublishReviewResultsTool } from './tools/publish-review-results.tool.js';

// 1. Fetch required environment variable config at initialization
const gatewayUrl = process.env.GATEWAY_URL;
if (!gatewayUrl) {
  throw new Error('GATEWAY_URL environment variable is required');
}

const reviewModel = process.env.REVIEW_MODEL;
if (!reviewModel) {
  throw new Error('REVIEW_MODEL environment variable is required');
}

// 2. Setup the tools with the gateway URL
const tools = {
  getRepoContext: createGetRepoContextTool(gatewayUrl),
  publishReviewResults: createPublishReviewResultsTool(gatewayUrl),
  getDiscussion: createGetDiscussionTool(gatewayUrl),
  storeDiscussion: createStoreDiscussionTool(gatewayUrl),
};

// 3. Export the LlmAgent instance.
export const codeReviewAgent = createOrchestrator({
  tools,
  model: reviewModel,
});
export const rootAgent = codeReviewAgent;
export default codeReviewAgent;
