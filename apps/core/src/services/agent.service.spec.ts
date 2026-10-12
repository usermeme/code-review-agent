import { describe, expect, it, vi } from 'vitest';

import { AgentService } from './agent.service.js';

vi.mock('agent-context-builder', () => ({
  buildContext: vi.fn().mockResolvedValue({
    architecture: 'Test Architecture',
  }),
}));

vi.mock('agent-code-reviewer', () => ({
  runReview: vi.fn().mockResolvedValue({
    provider: 'github',
    owner: 'test-org',
    repo: 'test-repo',
    prNumber: 1,
    summary: 'Test summary',
    comments: [],
  }),
}));

import { runReview } from 'agent-code-reviewer';
import { buildContext } from 'agent-context-builder';

describe('AgentService', () => {
  it('delegates buildContext to agent-context-builder library', async () => {
    const service = new AgentService();
    const result = await service.buildContext({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 1,
      cloneUrl: 'https://github.com/test-org/test-repo.git',
      ref: 'main',
      llm: 'test-model',
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-org',
        repo: 'test-repo',
        llm: 'test-model',
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
        llm: 'test-model',
      },
    );

    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: 'diff content',
      }),
      {
        llm: 'test-model',
      },
    );
    expect(result).toEqual(
      expect.objectContaining({
        summary: 'Test summary',
      }),
    );
  });
});
