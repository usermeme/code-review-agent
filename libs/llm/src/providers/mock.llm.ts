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

  private shouldSubmitReview(llmRequest: LlmRequest): boolean {
    if (this.generateResponseFn) {
      return false;
    }
    return Boolean(
      llmRequest.toolsDict && 'submit_review' in llmRequest.toolsDict,
    );
  }

  private resolveTextResponse(llmRequest: LlmRequest): string {
    if (!this.generateResponseFn) {
      return this.defaultResponse;
    }
    const res = this.generateResponseFn(llmRequest);
    return typeof res === 'string' ? res : JSON.stringify(res);
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.calls.push(llmRequest);

    if (this.shouldSubmitReview(llmRequest)) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'mock_submit_review_1',
                name: 'submit_review',
                args: { summary: this.defaultResponse, findings: [] },
              },
            },
          ],
        },
        turnComplete: true,
      };
      return;
    }

    const text = this.resolveTextResponse(llmRequest);
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
