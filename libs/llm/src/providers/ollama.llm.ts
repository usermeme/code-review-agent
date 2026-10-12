import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';

export interface OllamaLlmOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export class OllamaLlm extends BaseLlm {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: OllamaLlmOptions) {
    super({ model: options.model });
    this.baseUrl = (options.baseUrl || 'http://localhost:11434')
      .replace(/\/+$/, '')
      .replace(/\/v1$/, '');
    this.apiKey = options.apiKey;
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
      stream: false,
    };

    if (llmRequest.config?.responseMimeType === 'application/json') {
      payload['format'] = 'json';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `Ollama request failed with status ${res.status}: ${errText}`,
      );
    }

    const data = (await res.json()) as {
      message?: { content?: string };
    };

    const replyText = data.message?.content ?? '';

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
      'Live bidirectional connection is not supported by OllamaLlm',
    );
  }
}
