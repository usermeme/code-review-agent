import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';

export type StepResponder = (
  request: LlmRequest,
  callIndex: number,
) => LlmResponse;

export class ScriptedLlm extends BaseLlm {
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

export function createFunctionCallResponse(
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

/** A model reply that is plain text, e.g. a JSON answer. */
export function createTextResponse(text: string): LlmResponse {
  return { content: { role: 'model', parts: [{ text }] } };
}
