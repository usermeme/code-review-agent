import Anthropic from '@anthropic-ai/sdk';
import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import type { BaseLlmConnection } from '@google/adk';
import { fromAnthropicMessage, toAnthropicRequest, type ClaudeRequestOptions } from './claude-translate.service.js';

export interface ClaudeLlmOptions {
  model: string;
  thinking?: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  client?: Anthropic;
}

/**
 * Anthropic adapter for adk-js, which ships without Claude support. Review
 * runs are batch, so each request yields a single final LlmResponse; the
 * `stream` flag is ignored.
 */
export class ClaudeLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [/claude-.*/];

  private readonly options: ClaudeRequestOptions;
  private readonly client: Anthropic;

  constructor(options: ClaudeLlmOptions | { model: string }) {
    super({ model: options.model });
    this.options = options;
    this.client = 'client' in options && options.client ? options.client : new Anthropic();
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(llmRequest);
    const request = toAnthropicRequest(llmRequest, {
      ...this.options,
      model: this.model,
    });
    // Streaming transport avoids server-side timeouts on long generations,
    // even though we only surface the final message.
    const message = await this.client.messages.stream(request, { signal: abortSignal }).finalMessage();
    yield fromAnthropicMessage(message);
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('Live connections are not supported for Claude models.'));
  }
}
