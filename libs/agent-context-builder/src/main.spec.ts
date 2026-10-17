import {
  type GitAdapterContract,
  NonRetryableTaskError,
} from '@code-review-agent/shared-types';
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { describe, expect, it, vi } from 'vitest';

import { buildContext } from './main.js';

/** Deterministic fake model: answers every request with canned markdown. */
class FakeLlm extends BaseLlm {
  public calls: LlmRequest[] = [];

  constructor(private readonly respond: (request: LlmRequest) => string) {
    super({ model: 'fake-model' });
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, unknown> {
    this.calls.push(request);
    yield {
      content: { role: 'model', parts: [{ text: this.respond(request) }] },
      turnComplete: true,
    };
  }

  override async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    throw new Error('Live connection not supported by FakeLlm');
  }
}

const SECTIONS_MARKDOWN = [
  '## Architecture',
  'Microservices with Fastify.',
  '## Modules',
  'core, adapters.',
  '## Internal Patterns & Conventions',
  'Constructor injection everywhere.',
  '## Error Handling & Testing',
  'Fail-fast env validation; vitest.',
  '## Agent Docs (verbatim)',
  '# AGENTS.md',
].join('\n');

function incrementalAdapter(files: Array<Record<string, unknown>>) {
  return {
    getPRFiles: vi.fn().mockResolvedValue(files),
  } as unknown as GitAdapterContract;
}

describe('buildContext (deterministic pipeline)', () => {
  it('runs incremental pipeline: summarize, synthesize, store — without an orchestrator model turn', async () => {
    const llm = new FakeLlm((request) => {
      const text = request.contents?.[0]?.parts?.[0]?.text ?? '';
      return text.includes('analyzing one chunk')
        ? 'Chunk summary: Fastify services.'
        : SECTIONS_MARKDOWN;
    });
    const onStoreContext = vi.fn();

    const sections = await buildContext({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 7,
      isIncrementalUpdate: true,
      llm,
      gitAdapter: incrementalAdapter([
        {
          filename: 'src/main.ts',
          status: 'modified',
          content: 'console.log("hello");',
        },
      ]),
      onStoreContext,
    });

    expect(sections).toEqual({
      architecture: 'Microservices with Fastify.',
      modules: 'core, adapters.',
      patterns: 'Constructor injection everywhere.',
      errorHandling: 'Fail-fast env validation; vitest.',
      agentDocs: '# AGENTS.md',
    });
    expect(onStoreContext).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 0,
      sections,
    });
    // 1 chunk summary + 1 synthesis = exactly 2 LLM calls; no orchestration
    // turns and the synthesized document is never re-sent to the model.
    expect(llm.calls).toHaveLength(2);
  });

  it('uses summaryLlm for chunk summaries when provided', async () => {
    const synthesisLlm = new FakeLlm(() => SECTIONS_MARKDOWN);
    const summaryLlm = new FakeLlm(() => 'cheap summary');

    await buildContext({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 7,
      isIncrementalUpdate: true,
      llm: synthesisLlm,
      summaryLlm,
      gitAdapter: incrementalAdapter([
        { filename: 'src/a.ts', status: 'modified', content: 'const a = 1;' },
      ]),
    });

    expect(summaryLlm.calls).toHaveLength(1);
    expect(synthesisLlm.calls).toHaveLength(1);
  });

  it('returns the existing context without LLM calls when an incremental update has nothing summarizable', async () => {
    const llm = new FakeLlm(() => SECTIONS_MARKDOWN);
    const existing = { architecture: 'previous baseline' };

    const sections = await buildContext({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 7,
      isIncrementalUpdate: true,
      llm,
      contextLoader: vi.fn().mockResolvedValue(existing),
      gitAdapter: incrementalAdapter([
        { filename: 'pnpm-lock.yaml', status: 'modified', content: 'locked' },
      ]),
    });

    expect(sections).toEqual(existing);
    expect(llm.calls).toHaveLength(0);
  });

  it('fails loudly when a baseline build has nothing to summarize', async () => {
    const llm = new FakeLlm(() => SECTIONS_MARKDOWN);

    const build = buildContext({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 7,
      llm,
      gitAdapter: incrementalAdapter([]),
      isIncrementalUpdate: true,
    });

    await expect(build).rejects.toThrow('cannot build a baseline context');
    // Deterministic failure — consumers ack instead of redelivering.
    await expect(build).rejects.toBeInstanceOf(NonRetryableTaskError);
  });

  it('rejects payloads with missing required coordinates', async () => {
    const llm = new FakeLlm(() => SECTIONS_MARKDOWN);

    await expect(
      buildContext({
        provider: 'github',
        owner: '',
        repo: 'test-repo',
        llm,
      }),
    ).rejects.toThrow();
  });
});
