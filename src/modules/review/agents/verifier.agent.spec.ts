import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Finding } from '../schemas/review.schema.js';
import { verifyFindings } from './verifier.agent.js';
import type { PrDiff } from '../../../integrations/vcs/types/vcs.types.js';

/** Answers each verification call by matching the finding title in the prompt. */
class FakeLlm extends BaseLlm {
  constructor(private readonly answer: (prompt: string) => string) {
    super({ model: 'fake-model' });
  }

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const prompt = request.contents[0]?.parts?.[0]?.text ?? '';
    yield {
      content: { role: 'model', parts: [{ text: this.answer(prompt) }] },
      turnComplete: true,
    };
    await Promise.resolve();
  }

  override connect(): never {
    throw new Error('not supported');
  }
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    title: 'default title',
    severity: 'major',
    path: 'src/a.ts',
    startLine: 3,
    endLine: 3,
    body: 'body',
    confidence: 0.9,
    ...overrides,
  };
}

const FILES: PrDiff[] = [
  {
    filename: 'src/a.ts',
    status: 'modified',
    patch: '@@ -1,3 +1,5 @@\n a\n+b\n+c\n d\n e',
    additions: 2,
    deletions: 0,
  },
];

describe('verifyFindings', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'verifier-test-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'a.ts'),
      Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps confirmed findings and drops refuted ones', async () => {
    const llm = new FakeLlm((prompt) =>
      prompt.includes('real bug')
        ? JSON.stringify({ verdict: 'confirm', reasoning: 'checked' })
        : JSON.stringify({ verdict: 'refute', reasoning: 'guard exists on line 2' }),
    );
    const result = await verifyFindings({
      llm,
      checkoutDir: dir,
      findings: [finding({ title: 'real bug' }), finding({ title: 'false alarm' })],
      files: FILES,
      concurrency: 2,
    });
    expect(result.kept.map((f) => f.title)).toEqual(['real bug']);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.finding.title).toBe('false alarm');
    expect(result.dropped[0]!.reason).toContain('guard exists');
  });

  it('applies corrected line numbers from a confirming verdict', async () => {
    const llm = new FakeLlm(() =>
      JSON.stringify({ verdict: 'confirm', reasoning: 'off by two', correctedStartLine: 5, correctedEndLine: 6 }),
    );
    const target = finding({ startLine: 3, endLine: 4 });
    const result = await verifyFindings({ llm, checkoutDir: dir, findings: [target], files: FILES, concurrency: 1 });
    expect(result.kept[0]).toMatchObject({ startLine: 5, endLine: 6 });
  });

  it('ignores corrected lines that are out of bounds or inverted', async () => {
    const llm = new FakeLlm(() =>
      JSON.stringify({ verdict: 'confirm', reasoning: 'r', correctedStartLine: 999, correctedEndLine: 1000 }),
    );
    const target = finding({ startLine: 3, endLine: 4 });
    const result = await verifyFindings({ llm, checkoutDir: dir, findings: [target], files: FILES, concurrency: 1 });
    expect(result.kept[0]).toMatchObject({ startLine: 3, endLine: 4 });
  });

  it('drops findings pointing at files that do not exist in the checkout', async () => {
    const llm = new FakeLlm(() => JSON.stringify({ verdict: 'confirm', reasoning: 'r' }));
    const result = await verifyFindings({
      llm,
      checkoutDir: dir,
      findings: [finding({ path: 'src/hallucinated.ts' })],
      files: FILES,
      concurrency: 1,
    });
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.reason).toContain('does not exist');
  });

  it('keeps findings when the verification call fails (fail open)', async () => {
    const llm = new FakeLlm(() => 'this is not json');
    const result = await verifyFindings({
      llm,
      checkoutDir: dir,
      findings: [finding({ title: 'kept despite llm failure' })],
      files: FILES,
      concurrency: 1,
    });
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });
});
