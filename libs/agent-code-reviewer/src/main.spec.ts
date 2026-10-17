import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { describe, expect, it } from 'vitest';

import { runReview } from './main.js';
import {
  ReviewBudgetExceededError,
  ReviewRunError,
  ReviewTimeoutError,
} from './utils/budget.util.js';

type Reply = (
  request: LlmRequest,
  abortSignal?: AbortSignal,
) => LlmResponse | Promise<LlmResponse>;

class ScriptedLlm extends BaseLlm {
  calls: LlmRequest[] = [];

  constructor(private readonly reply: Reply) {
    super({ model: 'scripted-model' });
  }

  override async *generateContentAsync(
    request: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.calls.push(request);
    yield await this.reply(request, abortSignal);
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}

const callTool = (
  name: string,
  args: Record<string, unknown>,
): LlmResponse => ({
  content: {
    role: 'model',
    parts: [{ functionCall: { id: `call-${Math.random()}`, name, args } }],
  },
  turnComplete: true,
});

const text = (value: string): LlmResponse => ({
  content: { role: 'model', parts: [{ text: value }] },
  turnComplete: true,
});

const LOCKFILE_MARKER = 'LOCKFILE_CONTENT_MUST_NOT_REACH_THE_MODEL';

const input = {
  prMeta: {
    provider: 'github',
    owner: 'acme',
    repo: 'shop',
    number: 7,
    title: 'Bump deps',
    author: 'dev',
    branch: 'feat/deps',
  },
  diff: [
    'diff --git a/src/app.ts b/src/app.ts',
    '+const SOURCE_MARKER = 1;',
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    `+${LOCKFILE_MARKER}`,
  ].join('\n'),
  changedFiles: 'src/app.ts\npnpm-lock.yaml',
};

function requestText(request: LlmRequest): string {
  return JSON.stringify(request.contents ?? []);
}

function systemInstruction(request: LlmRequest): string {
  return JSON.stringify(request.config?.systemInstruction ?? '');
}

describe('runReview', () => {
  it('stops a model that never stops calling tools at the LLM call budget', async () => {
    const llm = new ScriptedLlm(() =>
      callTool('getDiscussion', { query: 'anything' }),
    );

    await expect(runReview(input, { llm, maxLlmCalls: 12 })).rejects.toThrow(
      ReviewBudgetExceededError,
    );
    expect(llm.calls).toHaveLength(12);
  });

  it('returns at the deadline even if a model call ignores the abort', async () => {
    const llm = new ScriptedLlm(
      () => new Promise<LlmResponse>(() => undefined),
    );

    await expect(runReview(input, { llm, timeoutMs: 50 })).rejects.toThrow(
      ReviewTimeoutError,
    );
  });

  it('fails instead of reporting "no findings" when the model request fails', async () => {
    const llm = new ScriptedLlm(() => ({
      errorCode: '429',
      errorMessage: 'RESOURCE_EXHAUSTED',
    }));

    await expect(runReview(input, { llm })).rejects.toThrow(ReviewRunError);
  });

  it('fails instead of publishing a clean review when a sub-agent fails', async () => {
    let published = false;
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return { errorCode: '429', errorMessage: 'RESOURCE_EXHAUSTED' };
      }
      const history = requestText(request);
      if (!history.includes('code_problems_agent')) {
        return callTool('code_problems_agent', { focus: 'all' });
      }
      if (!history.includes('publishReviewResults')) {
        return callTool('publishReviewResults', {
          summary: 'Looks good',
          findings: [],
        });
      }
      return text('done');
    });

    await expect(
      runReview(input, {
        llm,
        onPublishResult: () => {
          published = true;
        },
      }),
    ).rejects.toThrow(ReviewRunError);
    expect(published).toBe(false);
  });

  it('publishes when the sub-agents succeed', async () => {
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return callTool('set_model_response', { findings: [] });
      }
      const history = requestText(request);
      if (!history.includes('code_problems_agent')) {
        return callTool('code_problems_agent', { focus: 'all' });
      }
      if (!history.includes('publishReviewResults')) {
        return callTool('publishReviewResults', {
          summary: 'Looks good',
          findings: [],
        });
      }
      return text('done');
    });

    const result = await runReview(input, { llm });

    expect(result.summary).toBe('Looks good');
  });

  it('counts sub-agent LLM calls against the same budget', async () => {
    // The orchestrator keeps invoking a sub-agent, which itself loops on a
    // repo tool. Without a shared budget each sub-agent run would get ADK's
    // default of 500 calls.
    const llm = new ScriptedLlm((request) =>
      systemInstruction(request).includes('You hunt for real defects')
        ? callTool('searchRepositoryCode', { query: 'x' })
        : callTool('code_problems_agent', { focus: 'all' }),
    );

    await expect(runReview(input, { llm, maxLlmCalls: 20 })).rejects.toThrow(
      ReviewBudgetExceededError,
    );
    expect(llm.calls.length).toBeLessThanOrEqual(20);
  });

  it('aborts the run when it exceeds the time limit', async () => {
    // Like the real Gemini client: the request only ends when aborted.
    const llm = new ScriptedLlm(
      (_request, abortSignal) =>
        new Promise<LlmResponse>((_resolve, reject) =>
          abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    );

    await expect(runReview(input, { llm, timeoutMs: 50 })).rejects.toThrow(
      ReviewTimeoutError,
    );
  });

  it('keeps the diff out of the conversation and filters lockfiles', async () => {
    const llm = new ScriptedLlm(() => text('done'));

    await runReview(input, { llm });

    const [first] = llm.calls;
    expect(requestText(first)).not.toContain('SOURCE_MARKER');
    expect(systemInstruction(first)).toContain('SOURCE_MARKER');
    for (const call of llm.calls) {
      expect(requestText(call) + systemInstruction(call)).not.toContain(
        LOCKFILE_MARKER,
      );
    }
  });
});
