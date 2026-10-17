import type { BaseTool, Context, LlmRequest } from '@google/adk';
import { describe, expect, it } from 'vitest';

import {
  createLlmCallBudget,
  createToolCallLimiter,
  ReviewBudgetExceededError,
} from './budget.util.js';

const modelCall = { context: {} as Context, request: {} as LlmRequest };
const toolCall = (name: string) => ({
  tool: { name } as BaseTool,
  args: {},
  context: {} as Context,
});

describe('createLlmCallBudget', () => {
  it('allows exactly maxCalls calls, then throws', () => {
    const budget = createLlmCallBudget(2);

    expect(budget.beforeModel(modelCall)).toBeUndefined();
    expect(budget.beforeModel(modelCall)).toBeUndefined();

    expect(() => budget.beforeModel(modelCall)).toThrow(
      ReviewBudgetExceededError,
    );
    expect(budget.used()).toBe(3);
  });

  it('refuses calls once the abort signal fires', () => {
    const abort = new AbortController();
    const budget = createLlmCallBudget(10, abort.signal);
    abort.abort();

    expect(() => budget.beforeModel(modelCall)).toThrow(
      ReviewBudgetExceededError,
    );
  });
});

describe('createToolCallLimiter', () => {
  it('short-circuits a tool past its limit and leaves unlisted tools alone', () => {
    const limiter = createToolCallLimiter({ fetchRepositoryFile: 1 });

    expect(limiter(toolCall('fetchRepositoryFile'))).toBeUndefined();
    expect(limiter(toolCall('fetchRepositoryFile'))).toEqual({
      error: expect.stringContaining('Tool budget exhausted'),
    });
    expect(limiter(toolCall('set_model_response'))).toBeUndefined();
  });
});
