import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MockLlm } from '../providers/mock.llm.js';
import { generateJson } from './generate-json.js';

const schema = z.object({ answer: z.enum(['yes', 'no']) });

const BASE_OPTIONS = {
  systemInstruction: 'Answer yes or no.',
  prompt: 'Is the sky blue?',
  schema,
  timeoutMs: 1_000,
};

class HangingLlm extends BaseLlm {
  constructor() {
    super({ model: 'hanging' });
  }

  override async *generateContentAsync(
    _request: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    await new Promise<void>((resolve) =>
      abortSignal?.addEventListener('abort', () => resolve(), { once: true }),
    );
    yield { content: { role: 'model', parts: [{ text: '{"answer":"yes"}' }] } };
  }

  override connect(): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('Not implemented'));
  }
}

describe('generateJson', () => {
  it('returns the validated value and asks the model for JSON output', async () => {
    const llm = new MockLlm({ generateResponse: () => ({ answer: 'yes' }) });

    const result = await generateJson(llm, BASE_OPTIONS);

    expect(result).toMatchObject({ ok: true, value: { answer: 'yes' } });
    const request = llm.calls[0];
    expect(request.config?.responseMimeType).toBe('application/json');
    expect(request.config?.responseJsonSchema).toBeDefined();
    expect(request.config?.systemInstruction).toBe('Answer yes or no.');
  });

  it('fails without throwing when the reply is not valid JSON', async () => {
    const llm = new MockLlm({ generateResponse: () => 'not json' });

    const result = await generateJson(llm, BASE_OPTIONS);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('JSON'),
    });
  });

  it('fails without throwing when the JSON does not match the schema', async () => {
    const llm = new MockLlm({ generateResponse: () => ({ answer: 'maybe' }) });

    const result = await generateJson(llm, BASE_OPTIONS);

    expect(result.ok).toBe(false);
  });

  it('fails with a timeout when the model does not answer in time', async () => {
    const result = await generateJson(new HangingLlm(), {
      ...BASE_OPTIONS,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, error: 'Model call timed out.' });
  });
});
