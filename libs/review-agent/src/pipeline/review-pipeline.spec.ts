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
import {
  type ReviewPipelineResult,
  runReviewPipeline,
} from './review-pipeline.js';

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

function finding(title: string, severity: 'critical' | 'major' | 'minor') {
  return {
    path: 'src/charge.ts',
    line: 2,
    severity,
    title,
    comment: `${title} explained.`,
  };
}

function reviewerFinds(...findings: ReturnType<typeof finding>[]) {
  return new ScriptedLlm([
    () =>
      createFunctionCallResponse('submit_review', {
        summary: 'Found issues.',
        findings,
      }),
  ]);
}

function verifierSays(args: Record<string, unknown>) {
  return new ScriptedLlm([
    () => ({
      ...createFunctionCallResponse('submit_verdicts', args),
      usageMetadata: { promptTokenCount: 700 },
    }),
  ]);
}

async function runWith(models: Parameters<typeof createMockAgentModels>[0]) {
  const { diffWorkspace, loadWorkspace } = workspaces();
  return runReviewPipeline(
    { prMeta: META, diffWorkspace, loadWorkspace },
    { ...OPTIONS, models: createMockAgentModels(models) },
  );
}

function published(result: ReviewPipelineResult) {
  if (!result.publish) throw new Error('Expected a published review.');
  return result.publish;
}

describe('runReviewPipeline verification', () => {
  it('drops rejected findings, corrects severity and rewrites the summary on a deep review', async () => {
    const verifier = verifierSays({
      verdicts: [
        { id: 0, verdict: 'drop', reason: 'Guarded by the caller.' },
        { id: 1, verdict: 'keep', severity: 'critical', reason: 'Crashes.' },
      ],
      summary: 'One real crash.',
    });

    const result = await runWith({
      triage: triageSays('deep'),
      reviewer: reviewerFinds(
        finding('False alarm', 'major'),
        finding('Division by zero', 'major'),
      ),
      verifier,
    });

    const comments = published(result).reviewResult.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('[CRITICAL] Division by zero');
    expect(published(result).publishedFindings).toEqual([
      expect.objectContaining({
        title: 'Division by zero',
        severity: 'critical',
      }),
    ]);
    expect(published(result).reviewResult.summary).toContain('One real crash.');
    expect(published(result).reviewResult.summary).toContain(
      'Verifier kept 1 of 2 checked findings.',
    );
    expect(result.metrics.usage.verifier!.promptTokens).toBe(700);
  });

  it('checks only major and critical findings on a light review', async () => {
    const verifier = verifierSays({
      verdicts: [{ id: 0, verdict: 'drop', reason: 'Not reachable.' }],
    });

    const result = await runWith({
      triage: triageSays('light'),
      reviewer: reviewerFinds(
        finding('Small typo bug', 'minor'),
        finding('Wrong total', 'major'),
      ),
      verifier,
    });

    const prompt = JSON.stringify(verifier.requests[0].contents);
    expect(prompt).toContain('Wrong total');
    expect(prompt).not.toContain('Small typo bug');
    expect(verifier.requests[0].config?.thinkingConfig?.thinkingLevel).toBe(
      ThinkingLevel.MEDIUM,
    );
    const comments = published(result).reviewResult.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('Small typo bug');
  });

  it('does not call the verifier for a light review with only minor findings', async () => {
    const verifier = verifierSays({ verdicts: [] });

    const result = await runWith({
      triage: triageSays('light'),
      reviewer: reviewerFinds(finding('Small typo bug', 'minor')),
      verifier,
    });

    expect(verifier.requests).toHaveLength(0);
    expect(published(result).reviewResult.comments).toHaveLength(1);
    expect(result.metrics.usage.verifier).toBeUndefined();
  });

  it('keeps every finding when the verifier never submits verdicts', async () => {
    const verifier = new ScriptedLlm([
      () => createTextResponse('I have no opinion.'),
    ]);

    const result = await runWith({
      triage: triageSays('deep'),
      reviewer: reviewerFinds(
        finding('First issue', 'major'),
        finding('Second issue', 'critical'),
      ),
      verifier,
    });

    expect(published(result).reviewResult.comments).toHaveLength(2);
    expect(published(result).reviewResult.summary).toContain(
      'not double-checked (verifier unavailable)',
    );
  });

  it('keeps a candidate the verifier did not rule on', async () => {
    const verifier = verifierSays({
      verdicts: [{ id: 1, verdict: 'drop', reason: 'Duplicate.' }],
    });

    const result = await runWith({
      triage: triageSays('deep'),
      reviewer: reviewerFinds(
        finding('Unjudged issue', 'major'),
        finding('Dropped issue', 'major'),
      ),
      verifier,
    });

    const comments = published(result).reviewResult.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('Unjudged issue');
  });
});

describe('runReviewPipeline thread dedup', () => {
  it('shows existing threads to the reviewer and drops a repeated finding before the verifier', async () => {
    const reviewer = reviewerFinds(
      finding('Division by zero', 'major'),
      finding('Wrong rounding', 'major'),
    );
    const triage = new ScriptedLlm([
      () =>
        createTextResponse(
          JSON.stringify({ tier: 'deep', reason: 'Money.', focusFiles: [] }),
        ),
      () =>
        createTextResponse(
          JSON.stringify({
            matches: [
              { findingId: 0, threadId: 'T1' },
              { findingId: 1, threadId: 'none' },
            ],
          }),
        ),
    ]);
    const verifier = verifierSays({
      verdicts: [{ id: 0, verdict: 'keep', reason: 'Real.' }],
    });
    const { diffWorkspace, loadWorkspace } = workspaces();

    const result = await runReviewPipeline(
      {
        prMeta: META,
        diffWorkspace,
        loadWorkspace,
        reviewThreads: [
          {
            id: 'PRRT_1',
            path: 'src/charge.ts',
            line: 2,
            isResolved: false,
            isOutdated: false,
            comments: [
              { author: 'other-bot[bot]', body: 'b divides by zero here.' },
            ],
          },
        ],
      },
      {
        ...OPTIONS,
        models: createMockAgentModels({ triage, reviewer, verifier }),
      },
    );

    expect(JSON.stringify(reviewer.requests[0].contents)).toContain(
      'Existing Review Threads',
    );
    const verifierPrompt = JSON.stringify(verifier.requests[0].contents);
    expect(verifierPrompt).toContain('Wrong rounding');
    expect(verifierPrompt).not.toContain('Division by zero');
    const out = published(result);
    expect(out.reviewResult.comments).toHaveLength(1);
    expect(out.reviewResult.summary).toContain('already raised');
  });
});
