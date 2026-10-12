import { type BaseLlm, InMemoryRunner } from '@google/adk';
import type { GitAdapterContract } from 'shared-types';

import { createContextOrchestrator } from './agents/orchestrator.agent.js';
import {
  type ContextLoader,
  createFetchContextTool,
} from './tools/fetch-context.tool.js';
import { createPrepareRepoTool } from './tools/prepare-repo.tool.js';
import { createStoreContextTool } from './tools/store-context.tool.js';
import { createSummarizeRepoTool } from './tools/summarize-chunks.tool.js';
import { createSynthesizeContextTool } from './tools/synthesize-context.tool.js';

export interface BuildContextOptions {
  provider: string;
  owner: string;
  repo: string;
  prNumber?: number;
  cloneUrl?: string;
  ref?: string;
  gitAdapter?: GitAdapterContract;
  isIncrementalUpdate?: boolean;
  llm: BaseLlm;
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
  const llm = options.llm;
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
      gitAdapter: options.gitAdapter,
    }),
    summarizeChunks: createSummarizeRepoTool({ llm }),
    synthesizeContext: createSynthesizeContextTool({ llm }),
    storeContext,
  };

  const agent = createContextOrchestrator({
    llm,
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
