import { InMemoryRunner } from '@google/adk';
import { createContextOrchestrator } from './agents/orchestrator.agent.js';
import { createPrepareRepoTool } from './tools/prepare-repo.tool.js';
import { createStoreContextTool } from './tools/store-context.tool.js';
import { createSummarizeRepoTool } from './tools/summarize-chunks.tool.js';
import { createSynthesizeContextTool } from './tools/synthesize-context.tool.js';
import {
  createFetchContextTool,
  type ContextLoader,
} from './tools/fetch-context.tool.js';
import { envService } from './env.js';

export * from './constants/state-keys.constant.js';
export * from './tools/prepare-repo.tool.js';
export * from './tools/fetch-context.tool.js';
export * from './tools/summarize-chunks.tool.js';
export * from './tools/synthesize-context.tool.js';
export * from './tools/store-context.tool.js';
export * from './agents/orchestrator.agent.js';
export * from './services/chunker.service.js';
export * from './services/archive.service.js';
export * from './services/agent-docs.service.js';
export * from './env.js';

export interface BuildContextOptions {
  provider: string;
  owner: string;
  repo: string;
  prNumber?: number;
  cloneUrl?: string;
  ref?: string;
  githubToken?: string;
  isIncrementalUpdate?: boolean;
  model?: string;
  contextLoader?: ContextLoader;
  onStoreContext?: (result: {
    provider: string;
    owner: string;
    repo: string;
    prNumber?: number;
    sections: Record<string, string>;
  }) => Promise<void> | void;
}

export async function buildContext(
  options: BuildContextOptions,
): Promise<Record<string, string>> {
  const model = options.model ?? envService.get('REVIEW_MODEL');
  let resultSections: Record<string, string> = {};

  const storeContext = createStoreContextTool({
    onStoreContext: async (res) => {
      resultSections = res.sections;
      if (options.onStoreContext) {
        await options.onStoreContext(res);
      }
    },
  });

  const tools = {
    fetchContext: createFetchContextTool(options.contextLoader),
    prepareRepo: createPrepareRepoTool({
      githubToken: options.githubToken ?? envService.get('GITHUB_TOKEN'),
    }),
    summarizeChunks: createSummarizeRepoTool({ model }),
    synthesizeContext: createSynthesizeContextTool({ model }),
    storeContext,
  };

  const agent = createContextOrchestrator({
    model,
    tools,
  });

  const runner = new InMemoryRunner({ agent });
  for await (const event of runner.runEphemeral({
    userId: 'core-context-builder',
    newMessage: {
      parts: [{ text: JSON.stringify(options) }],
    },
  })) {
    void event;
  }

  return resultSections;
}
