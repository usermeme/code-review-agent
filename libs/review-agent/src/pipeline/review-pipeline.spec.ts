import { RepoWorkspace } from '@code-review-agent/agent-tools';
import { createMockAgentModels } from '@code-review-agent/llm';
import type { PRMeta } from '@code-review-agent/shared-types';
import { ThinkingLevel } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';

import {
  createFunctionCallResponse,
  createTextResponse,
  ScriptedLlm,
} from '../testing/scripted-llm.js';
import { runReviewPipeline } from './review-pipeline.js';

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

function diffFor(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,2 @@',
    ' export const a = 1;',
    '+export const b = a / 0;',
  ].join('\n');
}

function workspaces(path = 'src/charge.ts') {
  const rawDiff = diffFor(path);
  const diffWorkspace = new RepoWorkspace({
    files: new Map(),
    rawDiff,
    changedFiles: [path],
  });
  const fullWorkspace = new RepoWorkspace({
    files: new Map([
      [path, ['export const a = 1;', 'export const b = a / 0;']],
    ]),
    rawDiff,
    changedFiles: [path],
  });
  const loadWorkspace = vi.fn(async () => fullWorkspace);
  return { diffWorkspace, loadWorkspace };
}

function triageSays(tier: string, focusFiles: string[] = []) {
  return new ScriptedLlm([
    () =>
      createTextResponse(
        JSON.stringify({ tier, reason: `Triage chose ${tier}.`, focusFiles }),
      ),
  ]);
}

function reviewerSubmits() {
  return new ScriptedLlm([
    () =>
      createFunctionCallResponse('submit_review', {
        summary: 'Reviewed.',
        findings: [],
      }),
  ]);
}

const OPTIONS = { timeoutMs: 300_000 };

describe('runReviewPipeline', () => {
  it('skips silently on a rule without calling any model or loading the repo', async () => {
    const triage = triageSays('deep');
    const { diffWorkspace, loadWorkspace } = workspaces();

    const result = await runReviewPipeline(
      { prMeta: { ...META, isDraft: true }, diffWorkspace, loadWorkspace },
      { ...OPTIONS, models: createMockAgentModels({ triage }) },
    );

    expect(result.publish).toBeNull();
    expect(result.metrics.route).toMatchObject({
      tier: 'skip',
      source: 'rule',
    });
    expect(triage.requests).toHaveLength(0);
    expect(loadWorkspace).not.toHaveBeenCalled();
  });

  it('posts a summary and loads nothing when triage says skip', async () => {
    const { diffWorkspace, loadWorkspace } = workspaces();

    const result = await runReviewPipeline(
      { prMeta: META, diffWorkspace, loadWorkspace },
      {
        ...OPTIONS,
        models: createMockAgentModels({ triage: triageSays('skip') }),
      },
    );

    expect(result.publish?.reviewResult.summary).toContain(
      'Triage chose skip.',
    );
    expect(result.metrics.route.source).toBe('triage');
    expect(loadWorkspace).not.toHaveBeenCalled();
  });

  it('runs a light review at low effort with the focus files from triage', async () => {
    const reviewer = reviewerSubmits();
    const { diffWorkspace, loadWorkspace } = workspaces();

    const result = await runReviewPipeline(
      { prMeta: META, diffWorkspace, loadWorkspace },
      {
        ...OPTIONS,
        models: createMockAgentModels({
          triage: triageSays('light', ['src/charge.ts', 'not/in/pr.ts']),
          reviewer,
        }),
      },
    );

    const request = reviewer.requests[0];
    expect(request.config?.thinkingConfig?.thinkingLevel).toBe(
      ThinkingLevel.LOW,
    );
    const prompt = JSON.stringify(request.contents);
    expect(prompt).toContain('Focus Files');
    expect(prompt).not.toContain('not/in/pr.ts');
    expect(result.metrics.route.tier).toBe('light');
    expect(result.publish?.reviewResult.summary).toContain(
      'Review depth: light',
    );
  });

  it('fails open to a deep review when triage returns garbage', async () => {
    const reviewer = reviewerSubmits();
    const triage = new ScriptedLlm([() => createTextResponse('not json')]);
    const { diffWorkspace, loadWorkspace } = workspaces();

    const result = await runReviewPipeline(
      { prMeta: META, diffWorkspace, loadWorkspace },
      { ...OPTIONS, models: createMockAgentModels({ triage, reviewer }) },
    );

    expect(result.metrics.route).toMatchObject({
      tier: 'deep',
      source: 'fallback',
    });
    expect(reviewer.requests[0].config?.thinkingConfig?.thinkingLevel).toBe(
      ThinkingLevel.HIGH,
    );
  });

  it('goes straight to deep for a deep-review path without asking triage', async () => {
    const triage = triageSays('skip');
    const { diffWorkspace, loadWorkspace } = workspaces('src/auth/session.ts');

    const result = await runReviewPipeline(
      { prMeta: META, diffWorkspace, loadWorkspace },
      {
        ...OPTIONS,
        models: createMockAgentModels({ triage, reviewer: reviewerSubmits() }),
      },
    );

    expect(triage.requests).toHaveLength(0);
    expect(result.metrics.route).toMatchObject({
      tier: 'deep',
      source: 'rule',
    });
  });

  it('escalates a failed light review to deep and sums both usages', async () => {
    const reviewer = new ScriptedLlm([
      () => ({
        ...createTextResponse('I will not call submit_review.'),
        usageMetadata: { promptTokenCount: 100 },
      }),
      () => ({
        ...createFunctionCallResponse('submit_review', {
          summary: 'Deep review done.',
          findings: [],
        }),
        usageMetadata: { promptTokenCount: 200 },
      }),
    ]);
    const { diffWorkspace, loadWorkspace } = workspaces();

    const result = await runReviewPipeline(
      { prMeta: META, diffWorkspace, loadWorkspace },
      {
        ...OPTIONS,
        models: createMockAgentModels({
          triage: triageSays('light'),
          reviewer,
        }),
      },
    );

    expect(result.publish?.reviewResult.failure).toBeUndefined();
    expect(result.metrics.route.tier).toBe('deep');
    expect(result.metrics.route.reason).toContain('Escalated');
    expect(result.metrics.usage.reviewer?.promptTokens).toBe(300);
    expect(reviewer.requests[1].config?.thinkingConfig?.thinkingLevel).toBe(
      ThinkingLevel.HIGH,
    );
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
  });

  it('turns a triage skip into a light review for an explicit /review request', async () => {
    const reviewer = reviewerSubmits();
    const { diffWorkspace, loadWorkspace } = workspaces();

    const result = await runReviewPipeline(
      {
        prMeta: { ...META, action: 'manual_trigger' },
        diffWorkspace,
        loadWorkspace,
      },
      {
        ...OPTIONS,
        models: createMockAgentModels({ triage: triageSays('skip'), reviewer }),
      },
    );

    expect(result.metrics.route.tier).toBe('light');
    expect(reviewer.requests).toHaveLength(1);
  });
});
