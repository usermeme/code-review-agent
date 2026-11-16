import { RepoWorkspace } from '@code-review-agent/agent-tools';
import {
  choiceAnswer,
  type DecisionModel,
  MockDecisionModel,
  noulAnswer,
} from '@code-review-agent/llm';
import type { PRMeta } from '@code-review-agent/shared-types';
import { describe, expect, it } from 'vitest';

import { runTriage } from './triage.js';

const META: PRMeta = {
  provider: 'github',
  owner: 'acme',
  repo: 'payments',
  prNumber: 12,
  title: 'feat: add charge amount calculation',
  author: 'alice',
  branch: 'feat/charge',
  htmlUrl: 'https://github.com/acme/payments/pull/12',
  action: 'opened',
};

/** A workspace whose files change by `sizes[path]` added lines each. */
function workspaceWith(sizes: Record<string, number>): RepoWorkspace {
  const rawDiff = Object.entries(sizes)
    .map(([path, added]) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -0,0 +1,${added} @@`,
        ...Array.from({ length: added }, (_, i) => `+line ${i}`),
      ].join('\n'),
    )
    .join('\n');
  return new RepoWorkspace({
    files: new Map(),
    rawDiff,
    changedFiles: Object.keys(sizes),
  });
}

const WORKSPACE = workspaceWith({ 'src/charge.ts': 3, 'src/util.ts': 1 });

function triageOn(
  model: DecisionModel,
  workspace = WORKSPACE,
  timeoutMs = 30_000,
) {
  return runTriage(model, { prMeta: META, workspace }, timeoutMs);
}

/** Answers the tier question; focus questions follow `focus` by file path. */
function model(
  tier: string,
  confidence: number,
  focus: Record<string, number> = {},
) {
  return new MockDecisionModel((id, question) => {
    if (id === 'tier') return choiceAnswer(question, tier, confidence);
    const asked = JSON.stringify(question.instructions);
    const path = Object.keys(focus).find((p) => asked.includes(`\`${p}\``));
    return noulAnswer(path ? (focus[path] ?? 0) : 0.1);
  });
}

describe('runTriage', () => {
  it('asks one tier choice and one focus question per changed file, in one call', async () => {
    const decider = model('light', 0.9);

    await triageOn(decider);

    expect(decider.requests).toMatchObject([
      {
        input: expect.stringContaining('feat: add charge amount calculation'),
        questions: {
          tier: {
            type: 'choice',
            criteria: {
              skip: expect.any(String),
              light: expect.any(String),
              deep: expect.any(String),
            },
          },
          focus_0: { type: 'noul' },
          focus_1: { type: 'noul' },
        },
      },
    ]);
    expect(Object.keys(decider.requests[0]?.questions ?? {})).toHaveLength(3);
  });

  it('takes a confident light answer, with the confidence in the reason', async () => {
    const result = await triageOn(model('light', 0.82));

    expect(result.route).toEqual({
      tier: 'light',
      reason: 'Small change contained in one area (triage confidence 82%).',
      source: 'triage',
    });
    expect(result.usage.calls).toBe(1);
  });

  it.each([
    ['light', 0.55, '60%'],
    ['skip', 0.75, '80%'],
  ])(
    'reviews at full depth when %s is below its confidence bar',
    async (tier, confidence, bar) => {
      const result = await triageOn(model(tier, confidence));

      expect(result.route.tier).toBe('deep');
      expect(result.route.source).toBe('triage');
      expect(result.route.reason).toContain(`below the ${bar} needed`);
    },
  );

  it('keeps likely-defect files as focus files, riskiest first', async () => {
    const result = await triageOn(
      model('light', 0.9, { 'src/util.ts': 0.8, 'src/charge.ts': 0.6 }),
    );

    expect(result.focusFiles).toEqual(['src/util.ts', 'src/charge.ts']);
  });

  it('drops files rated unlikely to hold a defect', async () => {
    const result = await triageOn(
      model('light', 0.9, { 'src/util.ts': 0.4, 'src/charge.ts': 0.7 }),
    );

    expect(result.focusFiles).toEqual(['src/charge.ts']);
  });

  it('asks about at most 50 files, largest diffs first', async () => {
    const sizes = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`src/f${i}.ts`, i + 1]),
    );
    const decider = model('deep', 0.9);

    await triageOn(decider, workspaceWith(sizes));

    const questions = decider.requests[0]?.questions ?? {};
    expect(Object.keys(questions)).toHaveLength(51);
    expect(JSON.stringify(questions['focus_0'])).toContain('src/f59.ts');
  });

  it('falls back to deep with the API error when the call fails', async () => {
    const failing: DecisionModel = {
      model: 'failing',
      decide: () => Promise.reject(new Error('404 model not found')),
    };

    const result = await triageOn(failing);

    expect(result.route).toEqual({
      tier: 'deep',
      reason:
        'Triage unavailable (404 model not found); reviewing at full depth.',
      source: 'fallback',
    });
    expect(result.focusFiles).toEqual([]);
  });

  it('makes no call when no time is left', async () => {
    const decider = model('skip', 0.99);

    const result = await triageOn(decider, WORKSPACE, 0);

    expect(decider.requests).toHaveLength(0);
    expect(result.route.source).toBe('fallback');
  });
});
