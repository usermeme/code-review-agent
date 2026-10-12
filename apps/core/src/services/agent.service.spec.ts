import { MockLlm } from '@code-review-agent/llm';
import { describe, expect, it, vi } from 'vitest';

import { AgentService } from './agent.service.js';

vi.mock('@code-review-agent/agent-context-builder', () => ({
  buildContext: vi.fn().mockResolvedValue({
    architecture: 'Test Architecture',
  }),
}));

vi.mock('@code-review-agent/agent-code-reviewer', () => ({
  runReview: vi.fn().mockResolvedValue({
    provider: 'github',
    owner: 'test-org',
    repo: 'test-repo',
    prNumber: 1,
    summary: 'Test summary',
    comments: [],
  }),
}));

import { runReview } from '@code-review-agent/agent-code-reviewer';
import { buildContext } from '@code-review-agent/agent-context-builder';

describe('AgentService', () => {
  const mockLlm = new MockLlm();

  it('delegates buildContext to agent-context-builder library', async () => {
    const service = new AgentService();
    const result = await service.buildContext({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 1,
      cloneUrl: 'https://github.com/test-org/test-repo.git',
      ref: 'main',
      llm: mockLlm,
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-org',
        repo: 'test-repo',
        llm: mockLlm,
      }),
    );
    expect(result).toEqual({ architecture: 'Test Architecture' });
  });

  it('delegates runReview to agent-code-reviewer library', async () => {
    const service = new AgentService();
    const result = await service.runReview(
      {
        prMeta: {
          provider: 'github',
          owner: 'test-org',
          repo: 'test-repo',
          number: 1,
          title: 'PR Title',
          author: 'author',
          branch: 'main',
          body: 'PR Body',
        },
        diff: 'diff content',
        changedFiles: 'main.ts',
        tickets: [],
      },
      {
        llm: mockLlm,
      },
    );

    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: 'diff content',
      }),
      {
        llm: mockLlm,
      },
    );
    expect(result).toEqual(
      expect.objectContaining({
        summary: 'Test summary',
      }),
    );
  });
});
