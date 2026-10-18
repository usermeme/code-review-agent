import type { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';
import type { Part } from '@google/genai';

/** One-shot text generation against a BaseLlm, outside any agent/session. */
export async function generateText(
  llm: BaseLlm,
  params: { prompt: string; system?: string },
): Promise<string> {
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

/** Parts carried by a response's content, or none when it has no content. */
function responseParts(response: LlmResponse): Part[] {
  return response.content?.parts ?? [];
}

/** True when a part carries user-visible model text (not an internal thought). */
function isSpokenTextPart(part: Part): part is Part & { text: string } {
  return Boolean(part.text) && !('thought' in part && part.thought);
}

async function collectText(llm: BaseLlm, request: LlmRequest): Promise<string> {
  let text = '';
  for await (const response of llm.generateContentAsync(request)) {
    if (response.partial) continue;
    for (const part of responseParts(response)) {
      if (isSpokenTextPart(part)) text += part.text;
    }
  }
  return text;
}
