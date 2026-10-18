import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import type {
  SingleBeforeModelCallback,
  SingleBeforeToolCallback,
} from '@google/adk';

/**
 * Hard limits enforced in code. Prompt-level "at most N calls" instructions
 * are advisory only; these callbacks are what actually stops a run.
 */

/**
 * Non-retryable: a redelivery would spend the same budget again and fail the
 * same way, so Pub/Sub must ack instead of redelivering.
 */
export class ReviewBudgetExceededError extends NonRetryableTaskError {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewBudgetExceededError';
  }
}

/** Non-retryable for the same reason as {@link ReviewBudgetExceededError}. */
export class ReviewTimeoutError extends NonRetryableTaskError {
  constructor(timeoutMs: number) {
    super(`Review exceeded its ${timeoutMs}ms time limit and was aborted.`);
    this.name = 'ReviewTimeoutError';
  }
}

export interface LlmCallBudget {
  readonly used: () => number;
  readonly exceeded: () => boolean;
  readonly beforeModel: SingleBeforeModelCallback;
}

/**
 * One budget shared by the orchestrator and every sub-agent. ADK's own
 * `RunConfig.maxLlmCalls` does not reach sub-agents: each `AgentTool` call
 * starts a fresh Runner with the default limit of 500.
 */
export function createLlmCallBudget(
  maxCalls: number,
  abortSignal?: AbortSignal,
): LlmCallBudget {
  let calls = 0;
  return {
    used: () => calls,
    exceeded: () => calls > maxCalls,
    beforeModel: () => {
      if (abortSignal?.aborted) {
        throw new ReviewBudgetExceededError(
          'Review was aborted; refusing further LLM calls.',
        );
      }
      calls += 1;
      if (calls > maxCalls) {
        throw new ReviewBudgetExceededError(
          `Review exceeded its budget of ${maxCalls} LLM calls.`,
        );
      }
      return undefined;
    },
  };
}

/**
 * Caps how many times each named tool may run. Once a tool's limit is reached
 * the call is short-circuited with an error the model can read, instead of
 * executing the tool. Tools not listed are unlimited (e.g. ADK's internal
 * `set_model_response`).
 */
export function createToolCallLimiter(
  limits: Record<string, number>,
): SingleBeforeToolCallback {
  const counts = new Map<string, number>();
  return ({ tool }) => {
    const limit = limits[tool.name];
    if (limit === undefined) return undefined;

    const next = (counts.get(tool.name) ?? 0) + 1;
    counts.set(tool.name, next);
    if (next > limit) {
      return {
        error: `Tool budget exhausted: ${tool.name} may be called at most ${limit} time(s) in this review. Do not call it again; continue with the information you already have.`,
      };
    }
    return undefined;
  };
}
