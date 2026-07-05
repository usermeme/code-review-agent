import type Anthropic from '@anthropic-ai/sdk';
import type { FinishReason, Content, Part, Schema } from '@google/genai';
import type { LlmRequest, LlmResponse } from '@google/adk';

/**
 * Pure translation layer between the genai types ADK speaks and the Anthropic
 * Messages API. Kept side-effect free so it can be golden-tested.
 */

const GENAI_TYPE_MAP: Record<string, string> = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
};

export function genaiSchemaToJsonSchema(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = schema.type as string | undefined;
  if (type) out['type'] = GENAI_TYPE_MAP[type] ?? type.toLowerCase();
  if (schema.description) out['description'] = schema.description;
  if (schema.enum) out['enum'] = schema.enum;
  if (schema.required) out['required'] = schema.required;
  if (schema.properties) {
    out['properties'] = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, genaiSchemaToJsonSchema(v)]),
    );
  }
  if (schema.items) out['items'] = genaiSchemaToJsonSchema(schema.items);
  if (schema.anyOf) out['anyOf'] = schema.anyOf.map(genaiSchemaToJsonSchema);
  return out;
}

function systemText(systemInstruction: unknown): string | undefined {
  if (!systemInstruction) return undefined;
  if (typeof systemInstruction === 'string') return systemInstruction;
  let parts: Part[];
  if (Array.isArray(systemInstruction)) {
    parts = systemInstruction.map((p: unknown) => (typeof p === 'string' ? { text: p } : (p as Part)));
  } else {
    parts = (systemInstruction as Content).parts ?? [];
  }
  const text = parts
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function processContentPart(
  part: Part,
  pendingIdsByName: Map<string, string[]>,
  getId: () => string,
): Anthropic.ContentBlockParam | undefined {
  if ('thought' in part && part.thought) return undefined;
  if (part.text !== undefined && part.text !== '') {
    return { type: 'text', text: part.text };
  }
  if (part.functionCall) {
    const name = part.functionCall.name ?? 'unknown_tool';
    const id = part.functionCall.id ?? getId();
    const queue = pendingIdsByName.get(name) ?? [];
    queue.push(id);
    pendingIdsByName.set(name, queue);
    return {
      type: 'tool_use',
      id,
      name,
      input: part.functionCall.args ?? {},
    };
  }
  if (part.functionResponse) {
    const name = part.functionResponse.name ?? 'unknown_tool';
    const id = part.functionResponse.id ?? pendingIdsByName.get(name)?.shift();
    if (part.functionResponse.id) {
      const queue = pendingIdsByName.get(name);
      if (queue) {
        const idx = queue.indexOf(part.functionResponse.id);
        if (idx >= 0) queue.splice(idx, 1);
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: id ?? getId(),
      content: JSON.stringify(part.functionResponse.response ?? {}),
    };
  }
  return undefined;
}

/**
 * Converts ADK conversation contents into Anthropic messages. Tool-use ids are
 * carried over when present; when ADK omits them, deterministic ids are
 * generated and matched to tool results by function name in call order, since
 * Anthropic requires every tool_result to reference a prior tool_use id.
 */
export function contentsToMessages(contents: Content[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  const pendingIdsByName = new Map<string, string[]>();
  let generated = 0;
  const getId = () => `toolu_gen_${generated++}`;

  for (const content of contents) {
    const role: 'user' | 'assistant' = content.role === 'model' ? 'assistant' : 'user';
    const blocks: Anthropic.ContentBlockParam[] = [];

    for (const part of content.parts ?? []) {
      const block = processContentPart(part, pendingIdsByName, getId);
      if (block) blocks.push(block);
    }

    if (blocks.length === 0) continue;
    const previous = messages[messages.length - 1];
    if (previous && previous.role === role && Array.isArray(previous.content)) {
      previous.content.push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  }
  return messages;
}

function requestTools(llmRequest: LlmRequest): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const tool of llmRequest.config?.tools ?? []) {
    if (typeof tool !== 'object' || tool === null || !('functionDeclarations' in tool)) continue;
    for (const decl of tool.functionDeclarations ?? []) {
      if (!decl.name) continue;
      const schema = decl.parameters ? genaiSchemaToJsonSchema(decl.parameters) : { type: 'object', properties: {} };
      tools.push({
        name: decl.name,
        description: decl.description ?? '',
        input_schema: schema as Anthropic.Tool.InputSchema,
      });
    }
  }
  return tools;
}

export interface ClaudeRequestOptions {
  model: string;
  thinking?: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}

export function toAnthropicRequest(
  llmRequest: LlmRequest,
  options: ClaudeRequestOptions,
): Anthropic.MessageCreateParamsNonStreaming {
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: options.model,
    max_tokens: llmRequest.config?.maxOutputTokens ?? options.maxTokens ?? 16_000,
    messages: contentsToMessages(llmRequest.contents),
  };

  const system = systemText(llmRequest.config?.systemInstruction);
  if (system) request.system = system;

  const tools = requestTools(llmRequest);
  if (tools.length > 0) request.tools = tools;

  if (options.thinking) {
    (request as Anthropic.MessageCreateParamsNonStreaming & { thinking?: unknown }).thinking = { type: 'adaptive' };
  }

  const outputConfig: Record<string, unknown> = {};
  if (options.effort) outputConfig.effort = options.effort;
  // ADK sets responseSchema when the agent declares an outputSchema; map it to
  // Anthropic structured outputs so AgentTool's JSON.parse never fails.
  const responseSchema = llmRequest.config?.responseSchema;
  if (responseSchema && typeof responseSchema === 'object') {
    outputConfig.format = {
      type: 'json_schema',
      schema: genaiSchemaToJsonSchema(responseSchema),
    };
  }
  if (Object.keys(outputConfig).length > 0) {
    (request as Anthropic.MessageCreateParamsNonStreaming & { output_config?: unknown }).output_config = outputConfig;
  }

  return request;
}

const STOP_REASON_MAP: Record<string, FinishReason> = {
  end_turn: 'STOP' as FinishReason,
  stop_sequence: 'STOP' as FinishReason,
  tool_use: 'STOP' as FinishReason,
  max_tokens: 'MAX_TOKENS' as FinishReason,
  refusal: 'SAFETY' as FinishReason,
};

export function fromAnthropicMessage(message: Anthropic.Message): LlmResponse {
  const parts: Part[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push({ text: block.text });
    } else if (block.type === 'tool_use') {
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name,
          args: (block.input ?? {}) as Record<string, unknown>,
        },
      });
    }
    // thinking / redacted_thinking blocks are intentionally dropped.
  }

  return {
    content: { role: 'model', parts },
    turnComplete: true,
    finishReason: message.stop_reason ? STOP_REASON_MAP[message.stop_reason] : undefined,
    usageMetadata: {
      promptTokenCount: message.usage.input_tokens,
      candidatesTokenCount: message.usage.output_tokens,
      totalTokenCount: message.usage.input_tokens + message.usage.output_tokens,
    },
    modelVersion: message.model,
  };
}
