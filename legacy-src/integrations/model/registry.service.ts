import { LLMRegistry } from '@google/adk';
import { ClaudeLlm } from './claude-llm.service.js';

let registered = false;

/** Makes `model: 'claude-*'` strings resolvable anywhere in ADK. Idempotent. */
export function registerModels(): void {
  if (registered) return;
  LLMRegistry.register(ClaudeLlm);
  registered = true;
}
