import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { describe, expect, it } from 'vitest';

import { SubAgentFailedError } from './agents/orchestrator.agent.js';
import { runReview } from './main.js';
import {
  ReviewBudgetExceededError,
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
    const llm = new ScriptedLlm(() => callTool('getRepoGuidelines', {}));

    const failure = runReview(input, { llm, maxLlmCalls: 12 });
    await expect(failure).rejects.toThrow(ReviewBudgetExceededError);
    await expect(failure).rejects.toBeInstanceOf(NonRetryableTaskError);
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

  it('fails (retryably) instead of reporting "no findings" when the model request fails', async () => {
    const llm = new ScriptedLlm(() => ({
      errorCode: '429',
      errorMessage: 'RESOURCE_EXHAUSTED',
    }));

    const failure = runReview(input, { llm });
    await expect(failure).rejects.toThrow('RESOURCE_EXHAUSTED');
    await expect(failure).rejects.not.toBeInstanceOf(NonRetryableTaskError);
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
    ).rejects.toThrow(SubAgentFailedError);
    expect(published).toBe(false);
  });

  it('keeps blocking publish when an over-limit sub-agent retry is short-circuited', async () => {
    // The tool-call limiter answers a third call to an already-failed
    // sub-agent with an {error} response without running it. That response
    // must not be mistaken for a success and unblock publish.
    let published = false;
    let subAgentCalls = 0;
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return { errorCode: '429', errorMessage: 'RESOURCE_EXHAUSTED' };
      }
      if (subAgentCalls < 3) {
        subAgentCalls += 1;
        return callTool('code_problems_agent', { focus: 'all' });
      }
      if (!requestText(request).includes('publishReviewResults')) {
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
    ).rejects.toThrow(SubAgentFailedError);
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
    const llm = new ScriptedLlm((request) =>
      requestText(request).includes('publishReviewResults')
        ? text('done')
        : callTool('publishReviewResults', { summary: 'ok', findings: [] }),
    );

    await runReview(input, { llm });

    const [first] = llm.calls;
    expect(requestText(first)).not.toContain('SOURCE_MARKER');
    expect(systemInstruction(first)).toContain('SOURCE_MARKER');
    for (const call of llm.calls) {
      expect(requestText(call) + systemInstruction(call)).not.toContain(
        LOCKFILE_MARKER,
      );
      expect(requestText(call) + systemInstruction(call)).not.toContain(
        'pnpm-lock.yaml',
      );
    }
  });

  it('surfaces SubAgentFailedError even when the orchestrator exits without calling publishReviewResults', async () => {
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return { errorCode: '429', errorMessage: 'RESOURCE_EXHAUSTED' };
      }
      const history = requestText(request);
      if (!history.includes('code_problems_agent')) {
        return callTool('code_problems_agent', { focus: 'all' });
      }
      return text('Sub-agent failed, stopping without publishing');
    });

    await expect(runReview(input, { llm })).rejects.toThrow(
      SubAgentFailedError,
    );
  });

  it('does not poison a previously successful sub-agent when a redundant over-limit call is short-circuited', async () => {
    let subAgentCalls = 0;
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return callTool('set_model_response', { findings: [] });
      }
      if (subAgentCalls < 3) {
        subAgentCalls += 1;
        return callTool('code_problems_agent', { focus: 'all' });
      }
      if (!requestText(request).includes('publishReviewResults')) {
        return callTool('publishReviewResults', {
          summary: 'Looks good after redundant calls',
          findings: [],
        });
      }
      return text('done');
    });

    const result = await runReview(input, { llm });
    expect(result.summary).toBe('Looks good after redundant calls');
  });
});
