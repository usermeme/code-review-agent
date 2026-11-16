import type { Decisions, GoogleGenAI } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';

import { GeminiDecisionModel } from './decision-model.js';

const QUESTIONS: Record<string, Decisions.Question> = {
  tier: {
    type: 'choice',
    instructions: 'Pick a tier.',
    criteria: { light: 'small', deep: 'big' },
  },
};

function fakeClient(response: Decisions.CreateDecisionResponse) {
  const create =
    vi.fn<(body: unknown, options?: unknown) => Promise<typeof response>>();
  create.mockResolvedValue(response);
  const client = { decisions: { create } } as unknown as Pick<
    GoogleGenAI,
    'decisions'
  >;
  return { client, create };
}

describe('GeminiDecisionModel', () => {
  it('sends the model as a resource name on the pinned API version', async () => {
    const { client, create } = fakeClient({ answers: {} });
    const signal = new AbortController().signal;

    await new GeminiDecisionModel(client, 'gemini-decision-1', 'v1beta').decide(
      { input: 'diff', questions: QUESTIONS, abortSignal: signal },
    );

    expect(create).toHaveBeenCalledWith(
      {
        api_version: 'v1beta',
        model: 'models/gemini-decision-1',
        input: 'diff',
        questions: QUESTIONS,
      },
      { signal },
    );
  });

  it('keeps a model id that is already a resource name', async () => {
    const { client, create } = fakeClient({ answers: {} });

    await new GeminiDecisionModel(client, 'models/x', 'v1beta').decide({
      input: 'diff',
      questions: QUESTIONS,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: 'models/x' });
  });

  it('returns the answers and counts input tokens as one call', async () => {
    const answers: Record<string, Decisions.Answer> = {
      tier: {
        type: 'choice',
        choice: 'deep',
        confidence: 0.7,
        probabilities: { light: 0.3, deep: 0.7 },
      },
    };
    const { client } = fakeClient({
      answers,
      usage: { total_input_tokens: 1200, total_cached_tokens: 200 },
    });

    const response = await new GeminiDecisionModel(
      client,
      'gemini-decision-1',
      'v1beta',
    ).decide({ input: 'diff', questions: QUESTIONS });

    expect(response).toEqual({
      answers,
      usage: {
        calls: 1,
        promptTokens: 1200,
        cachedTokens: 200,
        outputTokens: 0,
        thoughtsTokens: 0,
      },
    });
  });

  it('throws when the input was blocked', async () => {
    const { client } = fakeClient({
      prompt_feedback: {
        block_reason: 'safety',
        block_reason_message: 'Blocked.',
      },
    });

    await expect(
      new GeminiDecisionModel(client, 'gemini-decision-1', 'v1beta').decide({
        input: 'diff',
        questions: QUESTIONS,
      }),
    ).rejects.toThrow('Decision input blocked (safety): Blocked.');
  });
});
