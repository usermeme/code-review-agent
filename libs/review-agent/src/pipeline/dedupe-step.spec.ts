import {
  choiceAnswer,
  type DecisionModel,
  MockDecisionModel,
} from '@code-review-agent/llm';
import type { ReviewThread } from '@code-review-agent/shared-types';
import { describe, expect, it } from 'vitest';

import type { AnchoredFinding } from '../tools/submit-review.tool.js';
import { dedupeAgainstThreads } from './dedupe-step.js';

function anchored(title: string, line: number): AnchoredFinding {
  return {
    finding: {
      path: 'src/charge.ts',
      line,
      severity: 'major',
      title,
      comment: `${title} explained.`,
    },
    anchor: { line },
  };
}

function thread(overrides: Partial<ReviewThread>): ReviewThread {
  return {
    id: 'PRRT_1',
    path: 'src/charge.ts',
    line: 10,
    isResolved: false,
    isOutdated: false,
    comments: [
      { author: 'other-bot[bot]', body: '### [MAJOR] Divides by zero' },
    ],
    ...overrides,
  };
}

/** Answers each finding's question with the given thread id (or "none"). */
function modelSays(
  matches: Array<{ findingId: number; threadId: string }>,
  confidence = 0.9,
) {
  const byQuestion = new Map(
    matches.map((m) => [`finding_${m.findingId}`, m.threadId]),
  );
  return new MockDecisionModel((id, question) => {
    const threadId = byQuestion.get(id);
    return threadId ? choiceAnswer(question, threadId, confidence) : undefined;
  });
}

const REMAINING = 300_000;

describe('dedupeAgainstThreads', () => {
  it('drops a finding that repeats an open thread, from any author', async () => {
    const findings = [
      anchored('Division by zero', 11),
      anchored('Other bug', 12),
    ];

    const result = await dedupeAgainstThreads({
      findings,
      threads: [thread({})],
      model: modelSays([
        { findingId: 0, threadId: 'T1' },
        { findingId: 1, threadId: 'none' },
      ]),
      remainingMs: REMAINING,
    });

    expect(result.findings).toEqual([findings[1]]);
    expect(result.note).toContain('Skipped 1 finding');
  });

  it('asks one choice per finding over its nearby threads plus "none"', async () => {
    const model = modelSays([]);

    await dedupeAgainstThreads({
      findings: [anchored('Division by zero', 11)],
      threads: [thread({}), thread({ path: 'src/other.ts' })],
      model,
      remainingMs: REMAINING,
    });

    expect(model.requests[0]?.questions['finding_0']).toEqual({
      type: 'choice',
      instructions: expect.stringContaining('Division by zero'),
      criteria: {
        T1: expect.stringContaining('Divides by zero'),
        none: expect.any(String),
      },
    });
  });

  it('keeps a finding when the model is unsure about the match', async () => {
    const result = await dedupeAgainstThreads({
      findings: [anchored('Division by zero', 11)],
      threads: [thread({})],
      model: modelSays([{ findingId: 0, threadId: 'T1' }], 0.55),
      remainingMs: REMAINING,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.note).toBe('');
  });

  it('drops a finding that matches a resolved thread whose code is unchanged', async () => {
    const result = await dedupeAgainstThreads({
      findings: [anchored('Division by zero', 10)],
      threads: [thread({ isResolved: true })],
      model: modelSays([{ findingId: 0, threadId: 'T1' }]),
      remainingMs: REMAINING,
    });

    expect(result.findings).toHaveLength(0);
  });

  it('keeps a finding whose thread was resolved before the code changed, with the discussion as context', async () => {
    const finding = anchored('Division by zero', 10);
    const result = await dedupeAgainstThreads({
      findings: [finding],
      threads: [
        thread({
          isResolved: true,
          isOutdated: true,
          line: null,
          comments: [
            { author: 'other-bot[bot]', body: '### [MAJOR] Divides by zero' },
            { author: 'alice', body: 'Fixed by guarding the input.' },
          ],
        }),
      ],
      model: modelSays([{ findingId: 0, threadId: 'T1' }]),
      remainingMs: REMAINING,
    });

    expect(result.findings).toEqual([finding]);
    const context = result.context.get(finding) ?? '';
    expect(context).toContain('Divides by zero');
    expect(context).toContain('Fixed by guarding the input.');
  });

  it('makes no model call when no thread is near any finding', async () => {
    const model = modelSays([]);

    const result = await dedupeAgainstThreads({
      findings: [anchored('Division by zero', 200)],
      threads: [thread({ line: 10 }), thread({ path: 'src/other.ts' })],
      model,
      remainingMs: REMAINING,
    });

    expect(model.requests).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
  });

  it('keeps every finding when the decision call fails', async () => {
    const failing: DecisionModel = {
      model: 'failing',
      decide: () => Promise.reject(new Error('503 unavailable')),
    };
    const result = await dedupeAgainstThreads({
      findings: [anchored('Division by zero', 10)],
      threads: [thread({})],
      model: failing,
      remainingMs: REMAINING,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.note).toBe('');
  });

  it('ignores a thread id the model invented', async () => {
    const result = await dedupeAgainstThreads({
      findings: [anchored('Division by zero', 10)],
      threads: [thread({})],
      model: modelSays([{ findingId: 0, threadId: 'T99' }]),
      remainingMs: REMAINING,
    });

    expect(result.findings).toHaveLength(1);
  });
});
