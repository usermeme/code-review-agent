import { envService } from './env.js';
import { createOrchestrator } from './agents/orchestrator.agent.js';
import { createGetRepoContextTool } from './tools/get-repo-context.tool.js';
import { createGetDiscussionTool } from './tools/get-discussion.tool.js';
import { createStoreDiscussionTool } from './tools/store-discussion.tool.js';
import { createPublishReviewResultsTool } from './tools/publish-review-results.tool.js';

const coreUrl = envService.get('CORE_URL');
const reviewModel = envService.get('REVIEW_MODEL');

// 2. Setup the tools with the Core service URL and envService
const tools = {
  getRepoContext: createGetRepoContextTool(coreUrl),
  publishReviewResults: createPublishReviewResultsTool(coreUrl, { envService }),
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
