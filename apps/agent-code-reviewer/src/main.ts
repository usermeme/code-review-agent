import { createOrchestrator } from './agents/orchestrator.agent';
import { createGetRepoContextTool } from './tools/get-repo-context.tool';
import { createGetDiscussionTool } from './tools/get-discussion.tool';
import { createStoreDiscussionTool } from './tools/store-discussion.tool';

// 1. Fetch the required environment variable config at initialization
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
  getDiscussion: createGetDiscussionTool(gatewayUrl),
  storeDiscussion: createStoreDiscussionTool(gatewayUrl),
  repoFiles: [], // Context is loaded via gateway, direct repo clone is unnecessary here.
};

// 3. Export the LlmAgent instance.
// When running `adk deploy`, the deployment tool will inspect this module and wire the exported agent
// to the Google Cloud Pub/Sub ingress infrastructure automatically.
export const codeReviewAgent = createOrchestrator({ tools, model: reviewModel });
