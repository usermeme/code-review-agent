import type { GitAdapterContract } from '@code-review-agent/shared-types';
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { describe, expect, it, vi } from 'vitest';

import {
  type ReviewExecutionInput,
  ReviewNotSubmittedError,
  runReview,
} from './run-review.js';

type Responder = (request: LlmRequest) => LlmResponse['content'];

/** Plays a scripted conversation: each request is answered by the responder. */
class ScriptedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  readonly apiKey = 'SECRET-API-KEY';

  constructor(private readonly respond: Responder) {
    super({ model: 'scripted' });
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    yield { content: this.respond(request), turnComplete: true };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}

const systemOf = (request: LlmRequest) =>
  JSON.stringify(request.config?.systemInstruction ?? '');

const hasToolResult = (request: LlmRequest, name: string) =>
  request.contents.some((c) =>
    c.parts?.some((p) => p.functionResponse?.name === name),
  );

const call = (name: string, args: Record<string, unknown>) => ({
  role: 'model',
  parts: [{ functionCall: { name, args } }],
});

const text = (value: string) => ({ role: 'model', parts: [{ text: value }] });

const PLAN = {
  summary: 'One issue found',
  findings: [
    {
      title: 'Unchecked null',
      severity: 'major',
      path: 'src/app.ts',
      startLine: 3,
      endLine: 3,
      body: 'user may be null here, so .id throws.',
      confidence: 0.9,
    },
  ],
};

const input: ReviewExecutionInput = {
  prMeta: {
    provider: 'github',
    owner: 'acme',
    repo: 'shop',
    number: 7,
    title: 'Add profile page',
    author: 'dev',
    branch: 'feat/profile',
    baseRef: 'main',
  },
  diff: '+ const id = user.id; // FULL-DIFF-MARKER',
  context: {
    sections: {
      architecture: 'ARCH-FROM-CONTEXT',
      modules: 'modules',
      patterns: 'patterns',
      errorHandling: 'errors',
    },
    agentDocs: [{ path: 'AGENTS.md', content: 'Use pnpm.' }],
  },
};

const gitAdapter = {
  getFileContent: vi.fn().mockRejectedValue(new Error('not found')),
  searchCode: vi.fn().mockResolvedValue({ totalCount: 0, items: [] }),
} as unknown as GitAdapterContract;

describe('runReview', () => {
  it('runs a sub-agent on seeded state and returns the submitted plan for this PR', async () => {
    const llm = new ScriptedLlm((request) => {
      if (systemOf(request).includes('You hunt for real defects')) {
        return text(JSON.stringify({ findings: PLAN.findings }));
      }
      if (hasToolResult(request, 'submit_review')) return text('Submitted.');
      if (hasToolResult(request, 'code_problems_agent')) {
        return call('submit_review', PLAN);
      }
      return call('code_problems_agent', { focus: 'null handling' });
    });

    const result = await runReview(input, { llm, gitAdapter });

    expect(result).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'shop',
      prNumber: 7,
      summary: 'One issue found',
      ticketCoverage: undefined,
      comments: [expect.objectContaining({ path: 'src/app.ts', line: 3 })],
    });

    const subAgentRequest = llm.requests.find((r) =>
      systemOf(r).includes('You hunt for real defects'),
    );
    expect(systemOf(subAgentRequest)).toContain('FULL-DIFF-MARKER');
    expect(systemOf(subAgentRequest)).toContain('ARCH-FROM-CONTEXT');
  });

  it('keeps PR data out of the user message and never sends dependencies', async () => {
    const llm = new ScriptedLlm((request) =>
      hasToolResult(request, 'submit_review')
        ? text('Submitted.')
        : call('submit_review', PLAN),
    );

    await runReview(input, { llm, gitAdapter });

    const userText = JSON.stringify(llm.requests[0].contents);
    expect(userText).not.toContain('FULL-DIFF-MARKER');
    const sentToModel = JSON.stringify(
      llm.requests.map((r) => [r.contents, r.config?.systemInstruction]),
    );
    expect(sentToModel).not.toContain('SECRET-API-KEY');
    expect(systemOf(llm.requests[0])).toContain('Add profile page');
  });

  it('fails instead of posting an all-clear when no review is submitted', async () => {
    const llm = new ScriptedLlm(() => text('I reviewed it, looks fine.'));

    await expect(runReview(input, { llm, gitAdapter })).rejects.toBeInstanceOf(
      ReviewNotSubmittedError,
    );
  });
});
