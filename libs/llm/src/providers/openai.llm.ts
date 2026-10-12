import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';

export interface OpenAiLlmOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export class OpenAiLlm extends BaseLlm {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OpenAiLlmOptions) {
    super({ model: options.model });
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    );
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    void _stream;
    const messages: Array<{ role: string; content: string }> = [];

    const systemInstruction = llmRequest.config?.systemInstruction;
    if (typeof systemInstruction === 'string' && systemInstruction.trim()) {
      messages.push({ role: 'system', content: systemInstruction });
    } else if (
      typeof systemInstruction === 'object' &&
      systemInstruction !== null &&
      'parts' in systemInstruction &&
      Array.isArray(
        (systemInstruction as { parts: Array<{ text?: string }> }).parts,
      )
    ) {
      const sysText = (
        systemInstruction as { parts: Array<{ text?: string }> }
      ).parts
        .map((p) => p.text || '')
        .join('\n');
      if (sysText.trim()) {
        messages.push({ role: 'system', content: sysText });
      }
    }

    for (const content of llmRequest.contents || []) {
      const role = content.role === 'model' ? 'assistant' : 'user';
      const text = (content.parts || [])
        .map((p) => ('text' in p ? p.text : ''))
        .filter(Boolean)
        .join('\n');
      if (text) {
        messages.push({ role, content: text });
      }
    }

    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
    };

    if (llmRequest.config?.responseMimeType === 'application/json') {
      payload['response_format'] = { type: 'json_object' };
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `OpenAI request failed with status ${res.status}: ${errText}`,
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const replyText = data.choices?.[0]?.message?.content ?? '';

    yield {
      content: {
        role: 'model',
        parts: [{ text: replyText }],
      },
      turnComplete: true,
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    void _llmRequest;
    throw new Error(
      'Live bidirectional connection is not supported by OpenAiLlm',
    );
  }
}
