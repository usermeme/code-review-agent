import type { TokenUsage } from '@code-review-agent/shared-types';
import type { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';
import type { GenerateContentConfig } from '@google/genai';
import { z } from 'zod';

import { addUsageMetadata, emptyTokenUsage } from '../usage/token-usage.js';

export interface GenerateJsonOptions<T extends z.ZodType> {
  systemInstruction: string;
  prompt: string;
  schema: T;
  timeoutMs: number;
  /** Extra generation settings, e.g. `thinkingConfig`. */
  config?: Omit<
    GenerateContentConfig,
    'systemInstruction' | 'responseMimeType' | 'responseJsonSchema'
  >;
}

export type GenerateJsonResult<T> =
  | { ok: true; value: T; usage: TokenUsage }
  | { ok: false; error: string; usage: TokenUsage };

function buildRequest(
  llm: BaseLlm,
  options: GenerateJsonOptions<z.ZodType>,
): LlmRequest {
  return {
    model: llm.model,
    contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
    config: {
      ...options.config,
      systemInstruction: options.systemInstruction,
      responseMimeType: 'application/json',
      responseJsonSchema: z.toJSONSchema(options.schema),
    },
    liveConnectConfig: {},
    toolsDict: {},
  };
}

function assertNotError(response: LlmResponse): void {
  if (response.errorCode || response.errorMessage) {
    const code = response.errorCode ?? '';
    throw new Error(`Model error ${code}: ${response.errorMessage ?? ''}`);
  }
}

/** Concatenates the answer text of a response, leaving out thought parts. */
function answerText(response: LlmResponse): string {
  const parts = response.content?.parts ?? [];
  return parts
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('');
}

async function collectText(
  llm: BaseLlm,
  request: LlmRequest,
  usage: TokenUsage,
  abortSignal: AbortSignal,
): Promise<string> {
  let text = '';
  for await (const response of llm.generateContentAsync(
    request,
    false,
    abortSignal,
  )) {
    assertNotError(response);
    addUsageMetadata(usage, response.usageMetadata);
    text += answerText(response);
  }
  return text;
}

function parseJson<T extends z.ZodType>(
  text: string,
  schema: T,
): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Model did not return valid JSON.' };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Model JSON failed validation: ${parsed.error.message}`,
    };
  }
  return { ok: true, value: parsed.data };
}

function describeError(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'Model call timed out.';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Makes one structured-output call and validates the reply against `schema`.
 * Never throws: guards use the `ok: false` branch to fail open.
 */
export async function generateJson<T extends z.ZodType>(
  llm: BaseLlm,
  options: GenerateJsonOptions<T>,
): Promise<GenerateJsonResult<z.infer<T>>> {
  const usage = emptyTokenUsage();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), options.timeoutMs);
  try {
    const text = await collectText(
      llm,
      buildRequest(llm, options),
      usage,
      abortController.signal,
    );
    if (abortController.signal.aborted) {
      return { ok: false, error: 'Model call timed out.', usage };
    }
    const parsed = parseJson(text, options.schema);
    return parsed.ok
      ? { ok: true, value: parsed.value, usage }
      : { ok: false, error: parsed.error, usage };
  } catch (error: unknown) {
    return {
      ok: false,
      error: describeError(error, abortController.signal),
      usage,
    };
  } finally {
    clearTimeout(timer);
  }
}
