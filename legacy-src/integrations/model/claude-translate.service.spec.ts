import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@google/adk';
import {
  contentsToMessages,
  fromAnthropicMessage,
  genaiSchemaToJsonSchema,
  toAnthropicRequest,
} from './claude-translate.service.js';

function baseRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'claude-opus-4-8',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    config: {},
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

describe('genaiSchemaToJsonSchema', () => {
  it('converts uppercase genai types and nesting', () => {
    const schema = genaiSchemaToJsonSchema({
      type: 'OBJECT',
      required: ['name'],
      properties: {
        name: { type: 'STRING', description: 'the name' },
        count: { type: 'INTEGER' },
        tags: { type: 'ARRAY', items: { type: 'STRING', enum: ['a', 'b'] } },
      },
    } as never);
    expect(schema).toEqual({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'the name' },
        count: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      },
    });
  });
});

describe('contentsToMessages', () => {
  it('maps roles, merges consecutive same-role messages', () => {
    const messages = contentsToMessages([
      { role: 'user', parts: [{ text: 'a' }] },
      { role: 'user', parts: [{ text: 'b' }] },
      { role: 'model', parts: [{ text: 'c' }] },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toHaveLength(2);
    expect(messages[1]!.role).toBe('assistant');
  });

  it('round-trips tool calls with explicit ids', () => {
    const messages = contentsToMessages([
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'toolu_1', name: 'getRepoContext', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'toolu_1',
              name: 'getRepoContext',
              response: { ok: true },
            },
          },
        ],
      },
    ]);
    const toolUse = (
      messages[0]!.content as { type: string; id?: string }[]
    )[0]!;
    const toolResult = (
      messages[1]!.content as { type: string; tool_use_id?: string }[]
    )[0]!;
    expect(toolUse.type).toBe('tool_use');
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.tool_use_id).toBe('toolu_1');
  });

  it('matches tool results to generated ids by function name when ids are missing', () => {
    const messages = contentsToMessages([
      {
        role: 'model',
        parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'search', response: { hits: [] } } },
        ],
      },
    ]);
    const toolUse = (messages[0]!.content as { id?: string }[])[0]!;
    const toolResult = (messages[1]!.content as { tool_use_id?: string }[])[0]!;
    expect(toolUse.id).toBeDefined();
    expect(toolResult.tool_use_id).toBe(toolUse.id);
  });
});

describe('toAnthropicRequest', () => {
  it('maps system instruction, tools, thinking and response schema', () => {
    const request = toAnthropicRequest(
      baseRequest({
        config: {
          systemInstruction: 'be terse',
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'lookup',
                  description: 'find things',
                  parameters: {
                    type: 'OBJECT',
                    properties: { q: { type: 'STRING' } },
                  } as never,
                },
              ],
            },
          ],
          responseSchema: {
            type: 'OBJECT',
            properties: { ok: { type: 'BOOLEAN' } },
          },
        },
      }),
      { model: 'claude-opus-4-8', thinking: true, effort: 'high' },
    );
    expect(request.system).toBe('be terse');
    expect(request.tools?.[0]).toMatchObject({ name: 'lookup' });
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.output_config?.effort).toBe('high');
    expect(request.output_config?.format).toMatchObject({
      type: 'json_schema',
    });
    expect(request.max_tokens).toBe(16_000);
  });
});

describe('fromAnthropicMessage', () => {
  it('maps text, tool_use, usage and stop reason', () => {
    const response = fromAnthropicMessage({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [
        { type: 'text', text: 'done', citations: null },
        { type: 'tool_use', id: 'toolu_9', name: 'lookup', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as never);
    expect(response.content?.parts?.[0]?.text).toBe('done');
    expect(response.content?.parts?.[1]?.functionCall).toMatchObject({
      id: 'toolu_9',
      name: 'lookup',
    });
    expect(response.usageMetadata?.totalTokenCount).toBe(15);
    expect(response.turnComplete).toBe(true);
  });
});
