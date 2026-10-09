import { describe, expect, it, vi } from 'vitest';
import { DefaultAgentService } from './agent.service.js';

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

import { buildContext } from 'agent-context-builder';
import { runReview } from 'agent-code-reviewer';

describe('DefaultAgentService', () => {
  it('delegates buildContext to agent-context-builder library', async () => {
    const service = new DefaultAgentService();
    const result = await service.buildContext({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 1,
      cloneUrl: 'https://github.com/test-org/test-repo.git',
      ref: 'main',
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-org',
        repo: 'test-repo',
      }),
    );
    expect(result).toEqual({ architecture: 'Test Architecture' });
  });

  it('delegates runReview to agent-code-reviewer library', async () => {
    const service = new DefaultAgentService();
    const result = await service.runReview({
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
    });

    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: 'diff content',
      }),
      undefined,
    );
    expect(result).toEqual(
      expect.objectContaining({
        summary: 'Test summary',
      }),
    );
  });
});
