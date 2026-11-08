import { RepoWorkspace } from '@code-review-agent/agent-tools';
import type { PRMeta } from '@code-review-agent/shared-types';
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { describe, expect, it } from 'vitest';

import {
  buildReviewInstruction,
  buildReviewUserPrompt,
  runCodeReview,
} from './review-agent.js';

type StepResponder = (request: LlmRequest, callIndex: number) => LlmResponse;

class ScriptedLlm extends BaseLlm {
  public readonly requests: LlmRequest[] = [];
  private readonly steps: StepResponder[];

  constructor(steps: StepResponder[]) {
    super({ model: 'scripted-test-llm' });
    this.steps = steps;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const callIndex = this.requests.length;
    this.requests.push(llmRequest);
    const responder = this.steps[callIndex];
    if (!responder) {
      yield {
        content: {
          role: 'model',
          parts: [{ text: 'No more scripted steps.' }],
        },
      };
      return;
    }
    yield responder(llmRequest, callIndex);
  }

  override connect(): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('Not implemented'));
  }
}

function createFunctionCallResponse(
  name: string,
  args: Record<string, unknown>,
): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: `call_${name}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            args,
          },
        },
      ],
    },
  };
}

const SAMPLE_PR_META: PRMeta = {
  provider: 'github',
  owner: 'acme',
  repo: 'payments',
  prNumber: 12,
  title: 'feat: add charge amount calculation',
  author: 'alice',
  branch: 'feat/charge',
  body: 'Adds calculateTotal helper.',
  htmlUrl: 'https://github.com/acme/payments/pull/12',
  action: 'opened',
};

const SAMPLE_DIFF = [
  'diff --git a/src/charge.ts b/src/charge.ts',
  '--- a/src/charge.ts',
  '+++ b/src/charge.ts',
  '@@ -1,3 +1,4 @@',
  ' export function calculateTotal(items: number[], taxRate: number): number {',
  '+  const subtotal = items.reduce((sum, n) => sum + n, 0);',
  '+  return subtotal / taxRate;',
  '-  return 0;',
  ' }',
].join('\n');

function createSampleWorkspace(rawDiff = SAMPLE_DIFF): RepoWorkspace {
  return new RepoWorkspace({
    files: new Map([
      ['AGENTS.md', ['# Repo Rules', '- Never divide by taxRate.']],
      [
        'src/charge.ts',
        [
          'export function calculateTotal(items: number[], taxRate: number): number {',
          '  const subtotal = items.reduce((sum, n) => sum + n, 0);',
          '  return subtotal / taxRate;',
          '}',
        ],
      ],
      [
        'src/caller.ts',
        [
          'import { calculateTotal } from "./charge.js";',
          'export const total = calculateTotal([100, 200], 0);',
        ],
      ],
    ]),
    rawDiff,
    changedFiles: ['src/charge.ts'],
  });
}

describe('review-agent', () => {
  it('short-circuits with 0 LLM calls when the PR has no reviewable file changes', async () => {
    const workspace = new RepoWorkspace({
      files: new Map([['AGENTS.md', ['# Repo Rules']]]),
      rawDiff: [
        'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
        '--- a/pnpm-lock.yaml',
        '+++ b/pnpm-lock.yaml',
        '@@ -1,1 +1,1 @@',
        '-lockfileVersion: 6.0',
        '+lockfileVersion: 9.0',
      ].join('\n'),
      changedFiles: ['pnpm-lock.yaml'],
    });
    const llm = new ScriptedLlm([]);

    const result = await runCodeReview(
      { prMeta: SAMPLE_PR_META, workspace },
      { model: llm },
    );

    expect(llm.requests).toHaveLength(0);
    expect(result.reviewResult.comments).toEqual([]);
    expect(result.reviewResult.summary).toContain('No reviewable code changes');
    expect(result.reviewResult.failure).toBeUndefined();
  });

  it('executes repo tools (grep_code) and accepts a valid submit_review call', async () => {
    const workspace = createSampleWorkspace();
    const llm = new ScriptedLlm([
      () =>
        createFunctionCallResponse('grep_code', {
          pattern: 'calculateTotal',
        }),
      () =>
        createFunctionCallResponse('submit_review', {
          summary: 'Found a division-by-zero and tax calculation bug.',
          findings: [
            {
              path: 'src/charge.ts',
              startLine: 2,
              line: 3,
              severity: 'critical',
              title: 'Division by taxRate instead of multiplication',
              comment:
                '`caller.ts` passes `taxRate = 0`, causing `NaN`/`Infinity` when dividing by `taxRate`.',
              suggestion:
                '  const subtotal = items.reduce((sum, n) => sum + n, 0);\n  return subtotal * (1 + taxRate);',
            },
          ],
        }),
    ]);

    const result = await runCodeReview(
      { prMeta: SAMPLE_PR_META, workspace },
      { model: llm },
    );

    expect(llm.requests).toHaveLength(2);
    expect(result.reviewResult.failure).toBeUndefined();
    expect(result.reviewResult.summary).toBe(
      'Found a division-by-zero and tax calculation bug.',
    );
    expect(result.reviewResult.comments).toHaveLength(1);
    expect(result.reviewResult.comments[0]).toMatchObject({
      path: 'src/charge.ts',
      line: 3,
      startLine: 2,
    });
    expect(result.reviewResult.comments[0]?.body).toContain(
      '### [CRITICAL] Division by taxRate instead of multiplication',
    );
    expect(result.publishedFindings).toEqual([
      {
        path: 'src/charge.ts',
        startLine: 2,
        endLine: 3,
        severity: 'critical',
        title: 'Division by taxRate instead of multiplication',
      },
    ]);
  });

  it('allows the agent to self-correct when first submit_review uses an invalid diff line', async () => {
    const workspace = createSampleWorkspace();
    const llm = new ScriptedLlm([
      // First attempt uses line 99 (outside the diff hunk)
      () =>
        createFunctionCallResponse('submit_review', {
          summary: 'Initial review with wrong line number.',
          findings: [
            {
              path: 'src/charge.ts',
              line: 99,
              severity: 'major',
              title: 'Incorrect tax formula',
              comment: 'Should multiply instead of divide.',
            },
          ],
        }),
      // Second attempt fixes line to 3 (valid NEW-side diff line)
      () =>
        createFunctionCallResponse('submit_review', {
          summary: 'Corrected review with valid diff line.',
          findings: [
            {
              path: 'src/charge.ts',
              line: 3,
              severity: 'major',
              title: 'Incorrect tax formula',
              comment: 'Should multiply instead of divide.',
            },
          ],
        }),
    ]);

    const result = await runCodeReview(
      { prMeta: SAMPLE_PR_META, workspace },
      { model: llm },
    );

    expect(llm.requests).toHaveLength(2);
    expect(result.reviewResult.summary).toBe(
      'Corrected review with valid diff line.',
    );
    expect(result.reviewResult.comments).toHaveLength(1);
    expect(result.reviewResult.comments[0]?.line).toBe(3);
  });

  it('deduplicates findings that were already published on earlier PR commits', async () => {
    const workspace = createSampleWorkspace();
    const llm = new ScriptedLlm([
      () =>
        createFunctionCallResponse('submit_review', {
          summary: 'Incremental review.',
          findings: [
            {
              path: 'src/charge.ts',
              line: 3,
              severity: 'critical',
              title: 'Incorrect tax formula',
              comment: 'Already reported on previous commit.',
            },
          ],
        }),
    ]);

    const result = await runCodeReview(
      {
        prMeta: SAMPLE_PR_META,
        workspace,
        priorFindings: [
          {
            path: 'src/charge.ts',
            startLine: 2,
            endLine: 3,
            severity: 'critical',
            title: 'Incorrect tax formula',
          },
        ],
      },
      { model: llm },
    );

    expect(result.reviewResult.comments).toHaveLength(0);
    expect(result.publishedFindings).toHaveLength(1);
  });

  it('returns a failure payload when the model finishes without calling submit_review', async () => {
    const workspace = createSampleWorkspace();
    const llm = new ScriptedLlm([
      () => ({
        content: {
          role: 'model',
          parts: [{ text: 'I forgot to call submit_review.' }],
        },
      }),
    ]);

    const result = await runCodeReview(
      { prMeta: SAMPLE_PR_META, workspace },
      { model: llm },
    );

    expect(result.reviewResult.failure).toBeDefined();
    expect(result.reviewResult.comments).toEqual([]);
  });

  it('includes repo guidelines and prior findings in instruction and switches to get_pr_diff when diff exceeds inline budget', () => {
    const workspace = createSampleWorkspace();
    const instruction = buildReviewInstruction({
      prMeta: SAMPLE_PR_META,
      workspace,
      priorFindings: [
        {
          path: 'src/charge.ts',
          startLine: 2,
          endLine: 3,
          severity: 'major',
          title: 'Prior issue',
        },
      ],
    });

    expect(instruction).toContain('Never divide by taxRate.');
    expect(instruction).toContain('Prior issue');

    const inlinePrompt = buildReviewUserPrompt(
      { prMeta: SAMPLE_PR_META, workspace },
      10_000,
    );
    expect(inlinePrompt).toContain('L3 | +  return subtotal / taxRate;');

    const compactPrompt = buildReviewUserPrompt(
      { prMeta: SAMPLE_PR_META, workspace },
      10,
    );
    expect(compactPrompt).toContain('get_pr_diff');
  });

  it('does not truncate a diff of ~40,000 characters when maxInlineDiffChars is 80,000', () => {
    const line = '+  const variable_padding_line_number_ = 1234567890;\n';
    const body = line.repeat(700);
    const largeDiff = `diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n@@ -1,1 +1,701 @@\n${body}`;
    const workspace = new RepoWorkspace({
      files: new Map([['src/large.ts', ['const init = 1;']]]),
      rawDiff: largeDiff,
      changedFiles: ['src/large.ts'],
    });

    const userPrompt = buildReviewUserPrompt(
      { prMeta: SAMPLE_PR_META, workspace },
      80_000,
    );

    expect(userPrompt).toContain('### Annotated Unified Diff');
    expect(userPrompt).not.toContain('exceeds the inline threshold');
    expect(userPrompt.length).toBeGreaterThan(40_000);
  });

  it('recovers valid findings from fallback draft when submit_review was rejected and model stops without second submit', async () => {
    const workspace = createSampleWorkspace();
    const llm = new ScriptedLlm([
      () =>
        createFunctionCallResponse('submit_review', {
          summary: 'Found critical issue and an unanchored issue',
          findings: [
            {
              path: 'src/charge.ts',
              line: 3,
              severity: 'critical',
              title: 'Division by zero',
              comment: 'taxRate may be zero.',
            },
            {
              path: 'src/charge.ts',
              line: 999,
              severity: 'minor',
              title: 'Off diff line',
              comment: 'Anchored outside diff.',
            },
          ],
        }),
      () => ({
        content: {
          role: 'model',
          parts: [{ text: 'Ending conversation without correcting.' }],
        },
      }),
    ]);

    const result = await runCodeReview(
      { prMeta: SAMPLE_PR_META, workspace },
      { model: llm },
    );

    expect(result.reviewResult.failure).toBeUndefined();
    expect(result.reviewResult.comments).toHaveLength(1);
    expect(result.reviewResult.comments[0]?.body).toContain('Division by zero');
    expect(result.publishedFindings).toHaveLength(1);
    expect(result.publishedFindings[0]?.title).toBe('Division by zero');
  });
});
