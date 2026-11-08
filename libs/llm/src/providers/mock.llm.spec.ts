import type { BaseTool, LlmRequest, LlmResponse } from '@google/adk';
import type { Part } from '@google/genai';
import { describe, expect, it } from 'vitest';

import { MockLlm } from './mock.llm.js';

async function collectResponses(
  mock: MockLlm,
  req: LlmRequest,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const res of mock.generateContentAsync(req)) {
    responses.push(res);
  }
  return responses;
}

function extractFirstPart(responses: LlmResponse[]): Part | undefined {
  const parts = responses[0]?.content?.parts;
  if (!parts) {
    return undefined;
  }
  return parts[0];
}

describe('MockLlm', () => {
  const dummyRequest: LlmRequest = {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };

  it('yields default text response when no tools or custom generator', async () => {
    const mock = new MockLlm({ defaultResponse: 'Hello world' });
    const responses = await collectResponses(mock, dummyRequest);

    expect(responses).toHaveLength(1);
    const part = extractFirstPart(responses);
    expect(part?.text).toBe('Hello world');
    expect(mock.calls).toHaveLength(1);
  });

  it('yields a functionCall for submit_review when submit_review tool is present', async () => {
    const mock = new MockLlm({ defaultResponse: 'LGTM summary' });
    const reqWithTool: LlmRequest = {
      contents: [],
      toolsDict: {
        submit_review: {} as BaseTool,
      },
      liveConnectConfig: {},
    };

    const responses = await collectResponses(mock, reqWithTool);
    expect(responses).toHaveLength(1);
    const part = extractFirstPart(responses);
    expect(part?.functionCall).toEqual({
      id: 'mock_submit_review_1',
      name: 'submit_review',
      args: { summary: 'LGTM summary', findings: [] },
    });
  });

  it('yields custom generateResponseFn output even if submit_review is present', async () => {
    const mock = new MockLlm({
      generateResponse: () => 'Custom response',
    });
    const reqWithTool: LlmRequest = {
      contents: [],
      toolsDict: {
        submit_review: {} as BaseTool,
      },
      liveConnectConfig: {},
    };

    const responses = await collectResponses(mock, reqWithTool);
    expect(responses).toHaveLength(1);
    const part = extractFirstPart(responses);
    expect(part?.text).toBe('Custom response');
  });

  it('throws when calling connect', async () => {
    const mock = new MockLlm();
    await expect(mock.connect(dummyRequest)).rejects.toThrow(
      'Live connection not supported in MockLlm',
    );
  });
});
