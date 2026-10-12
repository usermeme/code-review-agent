import type { LlmRequest } from '@google/adk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OllamaLlm } from './ollama.llm.js';

describe('OllamaLlm', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends request to /api/chat with model and messages', async () => {
    const mockResponse = {
      message: {
        role: 'assistant',
        content: 'Review feedback from local model',
      },
      done: true,
    };

    let requestedUrl = '';
    let requestedBody: Record<string, unknown> = {};

    global.fetch = vi
      .fn()
      .mockImplementation(async (url: string, init: RequestInit) => {
        requestedUrl = url;
        requestedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: async () => mockResponse,
        };
      });

    const llm = new OllamaLlm({
      model: 'qwen2.5-coder:7b',
      baseUrl: 'http://localhost:11434',
    });

    const request: LlmRequest = {
      model: 'qwen2.5-coder:7b',
      config: {
        systemInstruction: 'You are an expert reviewer.',
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Review this code' }],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const results = [];
    for await (const response of llm.generateContentAsync(request)) {
      results.push(response);
    }

    expect(requestedUrl).toBe('http://localhost:11434/api/chat');
    expect(requestedBody['model']).toBe('qwen2.5-coder:7b');
    expect(requestedBody['stream']).toBe(false);
    expect(requestedBody['messages']).toEqual([
      { role: 'system', content: 'You are an expert reviewer.' },
      { role: 'user', content: 'Review this code' },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].content?.parts?.[0]?.text).toBe(
      'Review feedback from local model',
    );
  });

  it('includes format: "json" when responseMimeType is application/json', async () => {
    let requestedBody: Record<string, unknown> = {};

    global.fetch = vi
      .fn()
      .mockImplementation(async (_url: string, init: RequestInit) => {
        requestedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: async () => ({
            message: { role: 'assistant', content: '{"findings":[]}' },
          }),
        };
      });

    const llm = new OllamaLlm({
      model: 'llama3.2',
    });

    const request: LlmRequest = {
      model: 'llama3.2',
      config: {
        responseMimeType: 'application/json',
      },
      contents: [{ role: 'user', parts: [{ text: 'Output JSON' }] }],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const response of llm.generateContentAsync(request)) {
      expect(response).toBeDefined();
    }

    expect(requestedBody['format']).toBe('json');
  });

  it('throws an error when Ollama responds with non-ok status', async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 404,
        text: async () => 'model "unknown-model" not found',
      };
    });

    const llm = new OllamaLlm({ model: 'unknown-model' });

    const request: LlmRequest = {
      model: 'unknown-model',
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await expect(async () => {
      for await (const response of llm.generateContentAsync(request)) {
        expect(response).toBeDefined();
      }
    }).rejects.toThrow('Ollama request failed with status 404');
  });
});
