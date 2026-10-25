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

  it('fails instead of returning a clean review when a sub-agent fails', async () => {
    let published = false;
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return { errorCode: '429', errorMessage: 'RESOURCE_EXHAUSTED' };
      }
      const history = requestText(request);
      if (!history.includes('code_problems_agent')) {
        return callTool('code_problems_agent', { focus: 'all' });
      }
      // The orchestrator ends with a perfectly valid final report — it must
      // still be vetoed because a sub-agent failed.
      return text(JSON.stringify({ summary: 'Looks good', findings: [] }));
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

  it('keeps vetoing the report when an over-limit sub-agent retry is short-circuited', async () => {
    // The tool-call limiter answers a third call to an already-failed
    // sub-agent with an {error} response without running it. That response
    // must not be mistaken for a success and unblock the final report.
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
      return text(JSON.stringify({ summary: 'Looks good', findings: [] }));
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

  it('returns the finalized report when the sub-agents succeed', async () => {
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return callTool('set_model_response', { findings: [] });
      }
      const history = requestText(request);
      if (!history.includes('code_problems_agent')) {
        return callTool('code_problems_agent', { focus: 'all' });
      }
      return text(JSON.stringify({ summary: 'Looks good', findings: [] }));
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
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return callTool('set_model_response', { findings: [] });
      }
      const history = requestText(request);
      if (!history.includes('code_problems_agent')) {
        return callTool('code_problems_agent', { focus: 'all' });
      }
      return text(JSON.stringify({ summary: 'ok', findings: [] }));
    });

    await runReview(input, { llm });

    const orchestratorCall = llm.calls.find((c) =>
      systemInstruction(c).includes(
        'You orchestrate an autonomous code review',
      ),
    );
    const subAgentCall = llm.calls.find((c) =>
      systemInstruction(c).includes('You hunt for real defects'),
    );

    expect(orchestratorCall).toBeDefined();
    expect(subAgentCall).toBeDefined();

    expect(systemInstruction(orchestratorCall!)).toContain('src/app.ts');
    expect(systemInstruction(orchestratorCall!)).not.toContain('SOURCE_MARKER');
    expect(systemInstruction(subAgentCall!)).toContain('SOURCE_MARKER');

    for (const call of llm.calls) {
      expect(requestText(call)).not.toContain('SOURCE_MARKER');
      expect(requestText(call) + systemInstruction(call)).not.toContain(
        LOCKFILE_MARKER,
      );
      expect(requestText(call) + systemInstruction(call)).not.toContain(
        'pnpm-lock.yaml',
      );
    }
  });

  it('surfaces SubAgentFailedError even when the orchestrator exits without a parseable report', async () => {
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return { errorCode: '429', errorMessage: 'RESOURCE_EXHAUSTED' };
      }
      const history = requestText(request);
      if (!history.includes('code_problems_agent')) {
        return callTool('code_problems_agent', { focus: 'all' });
      }
      return text('Sub-agent failed, stopping without a final report');
    });

    await expect(runReview(input, { llm })).rejects.toThrow(
      SubAgentFailedError,
    );
  });

  it('fails retryably when the orchestrator never produces a parseable report', async () => {
    const llm = new ScriptedLlm((request) => {
      if (systemInstruction(request).includes('You hunt for real defects')) {
        return callTool('set_model_response', { findings: [] });
      }
      const history = requestText(request);
      if (!history.includes('code_problems_agent')) {
        return callTool('code_problems_agent', { focus: 'all' });
      }
      // Prose instead of the JSON report: a real (if unlikely) failure mode
      // that must never be laundered into a clean "no findings" review.
      return text('The review is complete. Everything looks fine!');
    });

    const failure = runReview(input, { llm });
    await expect(failure).rejects.toThrow(
      'finished without a parseable final report',
    );
    await expect(failure).rejects.not.toBeInstanceOf(NonRetryableTaskError);
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
      return text(
        JSON.stringify({
          summary: 'Looks good after redundant calls',
          findings: [],
        }),
      );
    });

    const result = await runReview(input, { llm });
    expect(result.summary).toBe('Looks good after redundant calls');
  });
});
