import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';

/**
 * Retry-aware LLM wrapper.
 *
 * Parallel dispatch (reviewer sub-agents, per-chunk context summaries) trades
 * wall-time for a higher instantaneous request rate, so provider failures that
 * are worth another attempt must be absorbed with exponential backoff + jitter
 * instead of failing the whole review. Two families are retried:
 *
 * - rate limits (429 / RESOURCE_EXHAUSTED / TOO_MANY_REQUESTS), and
 * - transient failures (5xx, connection resets, timeouts, DNS blips).
 *
 * Content is streamed downstream as it arrives; a failure that happens after
 * the first content response is surfaced rather than retried, because the
 * consumer has already seen output.
 *
 * Wrapping at the BaseLlm level covers every caller: the ADK agents, the
 * context-builder map step, and one-shot generateText.
 */
export interface LlmRetryOptions {
  /** Maximum number of retries per request (default 4). */
  maxRetries?: number;
  /** First backoff ceiling; doubles per attempt (default 1s). */
  baseDelayMs?: number;
  /** Backoff ceiling cap (default 30s). */
  maxDelayMs?: number;
  /** Injectable RNG for tests (default Math.random). */
  random?: () => number;
}

/** @deprecated Use {@link LlmRetryOptions}; retries are no longer rate-limit-only. */
export type RateLimitRetryOptions = LlmRetryOptions;

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;

const RATE_LIMIT_ERROR_CODES = new Set([
  '429',
  'RESOURCE_EXHAUSTED',
  'TOO_MANY_REQUESTS',
]);

/** Transport/server codes that are safe to retry: the request never took effect. */
const TRANSIENT_ERROR_CODES = new Set([
  '500',
  '502',
  '503',
  '504',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'INTERNAL',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
]);

const RATE_LIMIT_MESSAGE_PATTERN =
  /(?:\b429\b|resource[ _]exhausted|rate.?limit(?:ed|s)?\b|too many requests)/i;

const TRANSIENT_MESSAGE_PATTERN =
  /(?:socket hang up|network error|fetch failed|connection (?:reset|refused|closed)|timed? ?out|ECONN[A-Z]+|EAI_AGAIN|internal server error|bad gateway|service unavailable|gateway timeout)/i;

interface ErrorLike {
  status?: number;
  statusCode?: number;
  code?: number | string;
  errorCode?: number | string;
  errorMessage?: string;
  message?: string;
}

/** Any failure worth another attempt: rate limit or transient error. */
export function isRetryableLlmError(err: unknown): boolean {
  return isRetryableRateLimitError(err) || isTransientLlmError(err);
}

/** True when a thrown error looks like a provider rate limit (429 family). */
export function isRetryableRateLimitError(err: unknown): boolean {
  if (!isErrorLike(err)) return false;
  return (
    hasTooManyRequestsStatus(err) ||
    hasRateLimitErrorCode(err) ||
    hasRateLimitMessage(err)
  );
}

function hasServerError(err: ErrorLike): boolean {
  return isServerErrorStatus(err.status) || isServerErrorStatus(err.statusCode);
}

function hasTransientCode(err: ErrorLike): boolean {
  return isTransientErrorCode(err.code) || isTransientErrorCode(err.errorCode);
}

/** True when a thrown error is a transient transport/server failure. */
export function isTransientLlmError(err: unknown): boolean {
  if (!isErrorLike(err)) return false;
  return (
    hasServerError(err) || hasTransientCode(err) || hasTransientMessage(err)
  );
}

function isErrorLike(err: unknown): err is ErrorLike {
  return Boolean(err) && typeof err === 'object';
}

function errorMessage(candidate: ErrorLike): string {
  return candidate.errorMessage ?? candidate.message ?? '';
}

function isServerErrorStatus(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    value >= HTTP_SERVER_ERROR_MIN &&
    value <= HTTP_SERVER_ERROR_MAX
  );
}

function isTransientErrorCode(value: number | string | undefined): boolean {
  return value !== undefined && TRANSIENT_ERROR_CODES.has(String(value));
}

/** 429 in any of the status/code shapes providers use. */
function hasTooManyRequestsStatus(candidate: ErrorLike): boolean {
  return (
    candidate.status === HTTP_TOO_MANY_REQUESTS ||
    candidate.statusCode === HTTP_TOO_MANY_REQUESTS ||
    candidate.code === HTTP_TOO_MANY_REQUESTS ||
    candidate.code === String(HTTP_TOO_MANY_REQUESTS)
  );
}

/** A gRPC-style errorCode such as RESOURCE_EXHAUSTED. */
function hasRateLimitErrorCode(candidate: ErrorLike): boolean {
  if (candidate.errorCode === undefined) return false;
  return RATE_LIMIT_ERROR_CODES.has(String(candidate.errorCode));
}

function hasRateLimitMessage(candidate: ErrorLike): boolean {
  return RATE_LIMIT_MESSAGE_PATTERN.test(errorMessage(candidate));
}

function hasTransientMessage(candidate: ErrorLike): boolean {
  return TRANSIENT_MESSAGE_PATTERN.test(errorMessage(candidate));
}

/**
 * True when a yielded LlmResponse is an error response of the 429 family.
 * ADK surfaces provider errors both as thrown exceptions and as responses
 * carrying errorCode/errorMessage.
 */
export function isRetryableRateLimitResponse(response: LlmResponse): boolean {
  if (response.errorCode === undefined && response.errorMessage === undefined) {
    return false;
  }
  return isRetryableRateLimitError({
    errorCode: response.errorCode,
    errorMessage: response.errorMessage,
  });
}

/** Any yielded error response worth another attempt: 429 family or 5xx. */
export function isRetryableLlmResponse(response: LlmResponse): boolean {
  return (
    isRetryableRateLimitResponse(response) || isTransientLlmResponse(response)
  );
}

/** True when a yielded response is a transient 5xx/transport error response. */
function isTransientLlmResponse(response: LlmResponse): boolean {
  return (
    isServerErrorStatus(Number(response.errorCode)) ||
    isTransientErrorCode(response.errorCode) ||
    TRANSIENT_MESSAGE_PATTERN.test(response.errorMessage ?? '')
  );
}

/** Per-attempt state shared with the retry decisions. */
interface AttemptState {
  /** True once a content response reached the consumer (a retry is unsafe). */
  yieldedAny: boolean;
}

/** Fills in the documented defaults for the retry options. */
function resolveRetryOptions(
  options: LlmRetryOptions,
): Required<LlmRetryOptions> {
  return {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    random: options.random ?? Math.random,
  };
}

export class RetryingLlm extends BaseLlm {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;

  constructor(
    readonly inner: BaseLlm,
    options: LlmRetryOptions = {},
  ) {
    super({ model: inner.model });
    const resolved = resolveRetryOptions(options);
    this.maxRetries = resolved.maxRetries;
    this.baseDelayMs = resolved.baseDelayMs;
    this.maxDelayMs = resolved.maxDelayMs;
    this.random = resolved.random;
  }

  override async *generateContentAsync(
    request: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    for (let attempt = 0; ; attempt++) {
      const retry = yield* this.streamAttempt(
        request,
        stream,
        abortSignal,
        attempt,
      );
      if (!retry) return;
    }
  }

  /** Retries establishing the (bidi/live) connection on retryable failures. */
  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.inner.connect(llmRequest);
      } catch (err) {
        if (!isRetryableLlmError(err) || !this.canRetry(attempt)) throw err;
        await this.backoff(attempt);
      }
    }
  }

  /**
   * Streams one attempt. Content responses are forwarded to the consumer as
   * they arrive; a retryable failure before the first content response backs
   * off and returns `true` so the caller starts a fresh attempt. Once content
   * has been yielded a retry would duplicate output, so the error is surfaced.
   */
  private async *streamAttempt(
    request: LlmRequest,
    stream: boolean | undefined,
    abortSignal: AbortSignal | undefined,
    attempt: number,
  ): AsyncGenerator<LlmResponse, boolean> {
    const state: AttemptState = { yieldedAny: false };
    try {
      for await (const response of this.inner.generateContentAsync(
        request,
        stream,
        abortSignal,
      )) {
        if (isRetryableLlmResponse(response)) {
          if (
            await this.shouldRetryAfterResponse(state, attempt, abortSignal)
          ) {
            return true;
          }
          yield response;
          return false;
        }
        state.yieldedAny = true;
        yield response;
      }
      return false;
    } catch (err) {
      await this.retryOrThrow(err, state, attempt, abortSignal);
      return true;
    }
  }

  /** A yielded error is retryable only before any content reached the consumer. */
  private async shouldRetryAfterResponse(
    state: AttemptState,
    attempt: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (state.yieldedAny) return false;
    if (!this.canRetry(attempt, abortSignal)) return false;
    await this.backoff(attempt, abortSignal);
    return !abortSignal?.aborted;
  }

  private canAttemptRetry(
    err: unknown,
    state: AttemptState,
    attempt: number,
    abortSignal?: AbortSignal,
  ): boolean {
    return (
      isRetryableLlmError(err) &&
      !state.yieldedAny &&
      this.canRetry(attempt, abortSignal)
    );
  }

  /** Backs off a retryable thrown error; rethrows everything else. */
  private async retryOrThrow(
    err: unknown,
    state: AttemptState,
    attempt: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<void> {
    if (!this.canAttemptRetry(err, state, attempt, abortSignal)) throw err;
    await this.backoff(attempt, abortSignal);
    if (abortSignal?.aborted) throw err;
  }

  private canRetry(attempt: number, abortSignal?: AbortSignal): boolean {
    return attempt < this.maxRetries && !abortSignal?.aborted;
  }

  /** Exponential backoff with equal jitter: half deterministic, half random. */
  private backoff(attempt: number, abortSignal?: AbortSignal): Promise<void> {
    const exponential = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** attempt,
    );
    const delay = Math.floor(
      exponential / 2 + this.random() * (exponential / 2),
    );
    return new Promise((resolve) => {
      const timer = setTimeout(finish, delay);
      const onAbort = () => finish();
      function finish() {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Wraps `llm` so rate-limit and transient failures are retried with
 * exponential backoff + jitter.
 */
export function withLlmRetry(llm: BaseLlm, options?: LlmRetryOptions): BaseLlm {
  return new RetryingLlm(llm, options);
}

/** @deprecated Use {@link withLlmRetry}; retries are no longer rate-limit-only. */
export function withRateLimitRetry(
  llm: BaseLlm,
  options?: LlmRetryOptions,
): BaseLlm {
  return withLlmRetry(llm, options);
}
