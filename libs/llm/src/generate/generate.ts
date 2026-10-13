import type { BaseLlm, LlmRequest } from '@google/adk';
import { z } from 'zod';

export interface GenerateParams {
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
}

/** One-shot text generation against a BaseLlm, outside any agent/session. */
export async function generateText(
  llm: BaseLlm,
  params: GenerateParams,
): Promise<string> {
  const text = await collectText(llm, buildRequest(llm, params));
  if (!text) throw new Error(`Model ${llm.model} returned an empty response`);
  return text;
}

/**
 * One-shot JSON generation. The zod schema is sent to the provider as a JSON
 * schema for structured output, and the reply is additionally parsed leniently
 * and validated with zod, so a model that ignores the schema fails loudly
 * instead of quietly.
 */
export async function generateJson<T>(
  llm: BaseLlm,
  params: GenerateParams & { schema: z.ZodType<T> },
): Promise<T> {
  const request = buildRequest(llm, params);
  request.config = {
    ...request.config,
    responseMimeType: 'application/json',
    responseJsonSchema: z.toJSONSchema(params.schema),
  };
  const text = await collectText(llm, request);
  const result = params.schema.safeParse(extractJson(text));
  if (!result.success) {
    throw new Error(
      `Model ${llm.model} returned JSON not matching the expected schema; output was:\n${text.slice(0, 500)}`,
    );
  }
  return result.data;
}

const FENCED_JSON_REGEX = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/** Extracts the first parseable JSON value from model output (raw, fenced, or embedded). */
export function extractJson(text: string): unknown {
  const fenced = FENCED_JSON_REGEX.exec(text);
  const candidates = [
    text,
    fenced?.[1],
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1),
  ];
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

function buildRequest(llm: BaseLlm, params: GenerateParams): LlmRequest {
  return {
    model: llm.model,
    contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
    config: {
      ...(params.system ? { systemInstruction: params.system } : {}),
      ...(params.maxOutputTokens
        ? { maxOutputTokens: params.maxOutputTokens }
        : {}),
    },
    liveConnectConfig: {},
    toolsDict: {},
  };
}

async function collectText(llm: BaseLlm, request: LlmRequest): Promise<string> {
  let text = '';
  for await (const response of llm.generateContentAsync(request)) {
    if (response.partial) continue;
    for (const part of response.content?.parts ?? []) {
      if (part.text && !('thought' in part && part.thought)) text += part.text;
    }
  }
  return text;
}
