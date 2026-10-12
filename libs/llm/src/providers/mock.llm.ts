import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';

export interface MockLlmOptions {
  model?: string;
  defaultResponse?: string;
  generateResponse?: (request: LlmRequest) => string | Record<string, unknown>;
}

export class MockLlm extends BaseLlm {
  private readonly defaultResponse: string;
  private readonly generateResponseFn?: (
    request: LlmRequest,
  ) => string | Record<string, unknown>;

  public calls: LlmRequest[] = [];

  constructor(options: MockLlmOptions = {}) {
    super({ model: options.model || 'mock-model' });
    this.defaultResponse = options.defaultResponse || 'Mock LLM Response';
    this.generateResponseFn = options.generateResponse;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.calls.push(llmRequest);

    let text = this.defaultResponse;
    if (this.generateResponseFn) {
      const res = this.generateResponseFn(llmRequest);
      text = typeof res === 'string' ? res : JSON.stringify(res);
    }

    yield {
      content: {
        role: 'model',
        parts: [{ text }],
      },
      turnComplete: true,
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    void _llmRequest;
    throw new Error('Live connection not supported in MockLlm');
  }
}
