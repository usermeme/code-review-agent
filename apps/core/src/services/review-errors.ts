import {
  ReviewBudgetExceededError,
  ReviewRunError,
  ReviewTimeoutError,
} from '@code-review-agent/agent-code-reviewer';

/**
 * Decides whether a failed PR event is worth a Pub/Sub redelivery.
 *
 * Only transient infrastructure failures qualify. Anything else would fail
 * the same way on every attempt — and a review failure is paid for in LLM
 * tokens each time — so unknown errors default to NOT retryable.
 */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  // Node network errors
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  // Google API / gRPC status names (Gemini, Firestore, Pub/Sub)
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'ABORTED',
  'INTERNAL',
]);
/** gRPC numeric codes: DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE. */
const RETRYABLE_GRPC_CODES = new Set([4, 8, 10, 13, 14]);

const RETRYABLE_MESSAGE =
  /\b(429|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED)\b/;

function isRetryableCode(code: unknown): boolean {
  if (typeof code === 'number') {
    return RETRYABLE_STATUS.has(code) || RETRYABLE_GRPC_CODES.has(code);
  }
  if (typeof code === 'string') {
    return (
      RETRYABLE_CODES.has(code) || RETRYABLE_STATUS.has(Number.parseInt(code))
    );
  }
  return false;
}

export function isRetryableError(error: unknown): boolean {
  if (
    error instanceof ReviewBudgetExceededError ||
    error instanceof ReviewTimeoutError
  ) {
    return false;
  }
  if (error instanceof ReviewRunError) {
    // ADK reports thrown model-client errors as UNKNOWN_ERROR, so the HTTP
    // status of e.g. a Gemini rate limit only survives in the message.
    return isRetryableCode(error.code) || RETRYABLE_MESSAGE.test(error.message);
  }
  if (error && typeof error === 'object') {
    const { code, status } = error as { code?: unknown; status?: unknown };
    return isRetryableCode(code) || isRetryableCode(status);
  }
  return false;
}
