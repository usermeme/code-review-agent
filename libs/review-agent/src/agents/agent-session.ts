import { addUsageMetadata, emptyTokenUsage } from '@code-review-agent/llm';
import type { TokenUsage } from '@code-review-agent/shared-types';
import { InMemoryRunner, type LlmAgent } from '@google/adk';
import type { GenerateContentConfig, ThinkingLevel } from '@google/genai';

export interface AgentSessionOptions {
  agent: LlmAgent;
  prompt: string;
  maxLlmCalls: number;
  timeoutMs: number;
  /** Stops the session early once the agent has produced its result. */
  isDone: () => boolean;
}

export interface AgentSessionOutcome {
  usage: TokenUsage;
  /** Set when the run threw (including the abort after a timeout). */
  error?: unknown;
  timedOut: boolean;
}

/** `generateContentConfig` for an agent, with the thinking level if one is set. */
export function thinkingConfig(thinkingLevel: ThinkingLevel | undefined): {
  generateContentConfig?: GenerateContentConfig;
} {
  if (!thinkingLevel) return {};
  return { generateContentConfig: { thinkingConfig: { thinkingLevel } } };
}

async function drive(
  runner: InMemoryRunner,
  options: AgentSessionOptions,
  abortSignal: AbortSignal,
  usage: TokenUsage,
): Promise<void> {
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId: 'pr-reviewer',
  });
  const events = runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: options.prompt }] },
    runConfig: { maxLlmCalls: options.maxLlmCalls },
    abortSignal,
  });
  for await (const event of events) {
    addUsageMetadata(usage, event?.usageMetadata);
    if (options.isDone()) break;
  }
}

/**
 * Runs one ADK agent session under a call budget and a wall-clock timeout.
 * Never throws: failures come back in the outcome with the usage so far.
 */
export async function runAgentSession(
  options: AgentSessionOptions,
): Promise<AgentSessionOutcome> {
  const runner = new InMemoryRunner({
    appName: 'code-review-agent',
    agent: options.agent,
  });
  const usage = emptyTokenUsage();
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, options.timeoutMs);

  try {
    await drive(runner, options, abortController.signal, usage);
    return { usage, timedOut };
  } catch (error: unknown) {
    return { usage, error, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
