import type { BaseLlm, LlmRequest } from '@google/adk';
import type { Schema } from '@google/genai';
import type { z } from 'zod';

/** One-shot text generation against a BaseLlm, outside any agent/session. */
export async function generateText(llm: BaseLlm, params: { prompt: string; system?: string }): Promise<string> {
  const request: LlmRequest = {
    model: llm.model,
    contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
    config: params.system ? { systemInstruction: params.system } : {},
    liveConnectConfig: {},
    toolsDict: {},
  };
  const text = await collectText(llm, request);
  if (!text) throw new Error(`Model ${llm.model} returned an empty response`);
  return text;
}

/**
 * One-shot JSON generation. `responseSchema` rides the provider's structured
 * output support (Gemini responseSchema, Anthropic output_config via the
 * translate layer); the output is additionally parsed leniently and validated
 * with zod so a model that ignores the schema still fails loudly, not quietly.
 */
export async function generateJson<T>(
  llm: BaseLlm,
  params: {
    prompt: string;
    system?: string;
    responseSchema: Schema;
    schema: z.ZodType<T>;
  },
): Promise<T> {
  const request: LlmRequest = {
    model: llm.model,
    contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
    config: {
      ...(params.system ? { systemInstruction: params.system } : {}),
      responseSchema: params.responseSchema,
      responseMimeType: 'application/json',
    },
    liveConnectConfig: {},
    toolsDict: {},
  };
  const text = await collectText(llm, request);
  const value = extractJson(text);
  const result = params.schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Model ${llm.model} returned JSON not matching the expected schema; output was:\n${text.slice(0, 500)}`,
    );
  }
  return result.data;
}

/** Extracts the first parseable JSON value from model output (raw, fenced, or embedded). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidates = [text, fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

async function collectText(llm: BaseLlm, request: LlmRequest): Promise<string> {
  let text = '';
  for await (const response of llm.generateContentAsync(request)) {
    if (response.partial) continue;
    for (const part of response.content?.parts ?? []) {
      if (part.text && !part.thought) text += part.text;
    }
  }
  return text;
}
