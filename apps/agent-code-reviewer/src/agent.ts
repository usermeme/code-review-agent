import { createOrchestrator } from './agents/orchestrator.agent.js';
import { createGetRepoContextTool } from './tools/get-repo-context.tool.js';
import { createGetDiscussionTool } from './tools/get-discussion.tool.js';
import { createStoreDiscussionTool } from './tools/store-discussion.tool.js';
import { createPublishReviewResultsTool } from './tools/publish-review-results.tool.js';
import type { CodeReviewerEnvService } from './env.js';
import type { LlmAgent } from '@google/adk';

export function createCodeReviewerAgent(
  envService: CodeReviewerEnvService,
): LlmAgent {
  const coreUrl = envService.get('CORE_URL');
  const reviewModel = envService.get('REVIEW_MODEL');

  const tools = {
    getRepoContext: createGetRepoContextTool(coreUrl),
    publishReviewResults: createPublishReviewResultsTool(coreUrl, {
      envService,
    }),
    getDiscussion: createGetDiscussionTool(coreUrl),
    storeDiscussion: createStoreDiscussionTool(coreUrl),
  };

  return createOrchestrator({
    tools,
    model: reviewModel,
  });
}
