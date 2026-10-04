import { createOrchestrator } from './agents/orchestrator.agent.js';
import { createGetRepoContextTool } from './tools/get-repo-context.tool.js';
import { createGetDiscussionTool } from './tools/get-discussion.tool.js';
import { createStoreDiscussionTool } from './tools/store-discussion.tool.js';
import { createPublishReviewResultsTool } from './tools/publish-review-results.tool.js';

const coreUrl = process.env.CORE_URL;
if (!coreUrl) {
  throw new Error('CORE_URL environment variable is required');
}

const reviewModel = process.env.REVIEW_MODEL;
if (!reviewModel) {
  throw new Error('REVIEW_MODEL environment variable is required');
}

// 2. Setup the tools with the Core service URL
const tools = {
  getRepoContext: createGetRepoContextTool(coreUrl),
  publishReviewResults: createPublishReviewResultsTool(coreUrl),
  getDiscussion: createGetDiscussionTool(coreUrl),
  storeDiscussion: createStoreDiscussionTool(coreUrl),
};

// 3. Export the LlmAgent instance.
export const codeReviewAgent = createOrchestrator({
  tools,
  model: reviewModel,
});
export const rootAgent = codeReviewAgent;
export default codeReviewAgent;
