import { describe, expect, it } from 'vitest';

import { decide } from './decide.js';
import type {
  DecisionModel,
  DecisionQuestion,
  DecisionRequest,
} from './decision-model.js';
import {
  choiceAnswer,
  MockDecisionModel,
  noulAnswer,
} from './mock-decision-model.js';

const TIER: DecisionQuestion = {
  type: 'choice',
  instructions: 'Pick a tier.',
  criteria: { light: 'small', deep: 'big' },
};
const RISKY: DecisionQuestion = { type: 'noul', instructions: 'Risky?' };

function stubModel(
  decideFn: (request: DecisionRequest) => ReturnType<DecisionModel['decide']>,
): DecisionModel {
  return { model: 'stub', decide: decideFn };
}

describe('decide', () => {
  it('returns typed answers for every question', async () => {
    const model = new MockDecisionModel((id, question) =>
      id === 'tier' ? choiceAnswer(question, 'light', 0.8) : noulAnswer(0.7),
    );

    const result = await decide(model, {
      input: 'diff',
      questions: { tier: TIER, risky: RISKY },
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.choice('tier').choice).toBe('light');
    expect(result.answers.noul('risky').noul).toBe(0.7);
    expect(result.usage.calls).toBe(1);
  });

  it('fails when the model leaves a question unanswered', async () => {
    const model = stubModel(async () => ({
      answers: { tier: choiceAnswer(TIER, 'deep') },
      usage: {
        calls: 1,
        promptTokens: 5,
        cachedTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
      },
    }));

    const result = await decide(model, {
      input: 'diff',
      questions: { tier: TIER, risky: RISKY },
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'Decision model left questions unanswered: risky.',
      usage: { promptTokens: 5 },
    });
  });

  it('turns a thrown API error into ok: false', async () => {
    const model = stubModel(async () => {
      throw new Error('404 models/gemini-decision-1 is not found');
    });

    const result = await decide(model, {
      input: 'diff',
      questions: { tier: TIER },
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      error: '404 models/gemini-decision-1 is not found',
    });
  });

  it('aborts the call after the timeout', async () => {
    const model = stubModel(
      (request) =>
        new Promise((_, reject) => {
          request.abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );

    const result = await decide(model, {
      input: 'diff',
      questions: { tier: TIER },
      timeoutMs: 10,
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'Decision call timed out.',
    });
  });

  it('rejects an empty or oversized batch without calling the model', async () => {
    const model = new MockDecisionModel();
    const tooMany = Object.fromEntries(
      Array.from({ length: 1001 }, (_, i) => [`q${i}`, RISKY]),
    );

    const empty = await decide(model, {
      input: 'x',
      questions: {},
      timeoutMs: 1000,
    });
    const oversized = await decide(model, {
      input: 'x',
      questions: tooMany,
      timeoutMs: 1000,
    });

    expect(empty.ok).toBe(false);
    expect(oversized).toMatchObject({
      ok: false,
      error: expect.stringContaining('1001 > 1000'),
    });
    expect(model.requests).toHaveLength(0);
  });
});
