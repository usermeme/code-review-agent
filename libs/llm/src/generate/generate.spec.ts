import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MockLlm } from '../providers/mock.llm.js';
import { extractJson, generateJson, generateText } from './generate.js';

describe('generateText', () => {
  it('returns the model text and forwards the token budget', async () => {
    const llm = new MockLlm({ defaultResponse: 'hello' });

    const text = await generateText(llm, { prompt: 'hi', maxOutputTokens: 50 });

    expect(text).toBe('hello');
    expect(llm.calls[0].config?.maxOutputTokens).toBe(50);
  });

  it('throws on an empty response', async () => {
    const llm = new MockLlm({ generateResponse: () => '' });
    await expect(generateText(llm, { prompt: 'hi' })).rejects.toThrow(
      'empty response',
    );
  });
});

describe('generateJson', () => {
  const schema = z.object({ name: z.string() });

  it('sends the JSON schema and returns the validated value', async () => {
    const llm = new MockLlm({ generateResponse: () => ({ name: 'core' }) });

    const value = await generateJson(llm, { prompt: 'hi', schema });

    expect(value).toEqual({ name: 'core' });
    expect(llm.calls[0].config?.responseMimeType).toBe('application/json');
    expect(llm.calls[0].config?.responseJsonSchema).toMatchObject({
      type: 'object',
    });
  });

  it('throws when the reply does not match the schema', async () => {
    const llm = new MockLlm({ generateResponse: () => ({ other: 1 }) });
    await expect(generateJson(llm, { prompt: 'hi', schema })).rejects.toThrow(
      'not matching the expected schema',
    );
  });
});

describe('extractJson', () => {
  it('parses fenced JSON', () => {
    expect(extractJson('text\n```json\n{"a":1}\n```\nmore')).toEqual({ a: 1 });
  });

  it('returns undefined when nothing parses', () => {
    expect(extractJson('no json here')).toBeUndefined();
  });
});
