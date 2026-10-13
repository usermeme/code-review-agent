import { describe, expect, it, vi } from 'vitest';

vi.mock('@code-review-agent/agent-context-builder', () => ({
  buildRepoContext: vi.fn().mockResolvedValue({
    sections: {
      architecture: 'a',
      modules: 'm',
      patterns: 'p',
      errorHandling: 'e',
    },
    agentDocs: [],
  }),
}));

vi.mock('@code-review-agent/agent-code-reviewer', () => ({
  runReview: vi.fn().mockResolvedValue({
    provider: 'github',
    owner: 'test-org',
    repo: 'test-repo',
    prNumber: 42,
    summary: 'ok',
    comments: [],
  }),
}));

import { runReview } from '@code-review-agent/agent-code-reviewer';
import { buildRepoContext } from '@code-review-agent/agent-context-builder';
import type { GitAdapterContract } from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';

import { AgentService } from './agent.service.js';

describe('AgentService', () => {
  const llm = { model: 'test-model' } as BaseLlm;
  const gitAdapter = {} as GitAdapterContract;
  const service = new AgentService({ llm, gitAdapter });

  it('passes its own dependencies to buildRepoContext, separate from the input', async () => {
    const input = {
      mode: 'baseline',
      owner: 'test-org',
      repo: 'test-repo',
    } as const;

    await service.buildRepoContext(input);

    expect(buildRepoContext).toHaveBeenCalledWith(input, {
      llm,
      gitAdapter,
      logger: undefined,
    });
  });

  it('passes its own dependencies to runReview', async () => {
    const input = {
      prMeta: {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        number: 42,
        title: 't',
        author: 'a',
        branch: 'b',
      },
      diff: 'diff',
      context: null,
    };

    await service.runReview(input);

    expect(runReview).toHaveBeenCalledWith(input, { llm, gitAdapter });
  });
});
