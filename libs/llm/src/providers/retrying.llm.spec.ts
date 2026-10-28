import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { describe, expect, it, vi } from 'vitest';

import {
  isRetryableLlmError,
  isRetryableLlmResponse,
  isRetryableRateLimitError,
  isRetryableRateLimitResponse,
  isTransientLlmError,
  RetryingLlm,
  withLlmRetry,
  withRateLimitRetry,
} from './retrying.llm.js';

type Attempt = (request: LlmRequest) => LlmResponse | Promise<LlmResponse>;

class ScriptedLlm extends BaseLlm {
  attempts = 0;

  constructor(private readonly script: Attempt[]) {
    super({ model: 'scripted-model' });
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const attempt =
      this.script[Math.min(this.attempts, this.script.length - 1)];
    this.attempts += 1;
    yield await attempt(request);
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}

const ok = (value: string): LlmResponse => ({
  content: { role: 'model', parts: [{ text: value }] },
  turnComplete: true,
});

const rateLimitResponse: LlmResponse = {
  errorCode: '429',
  errorMessage: 'RESOURCE_EXHAUSTED',
};

const unavailableResponse: LlmResponse = {
  errorCode: '503',
  errorMessage: 'UNAVAILABLE',
};

/** Realistic model request used by the collect helper. */
function modelRequest(llm: BaseLlm): LlmRequest {
  return {
    model: llm.model,
    contents: [],
    config: {},
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** Zero-delay retry config so specs never sleep. */
const fastRetries = { baseDelayMs: 1, maxDelayMs: 2, random: () => 0.5 };

/** A promise plus an opener, so tests can control when an inner stream resumes. */
function createGate(): { wait: Promise<void>; open: () => void } {
  let open: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open?.() };
}

async function collect(llm: BaseLlm): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(modelRequest(llm))) {
    responses.push(response);
  }
  return responses;
}

describe('retry classification', () => {
  it('detects the 429 family in thrown errors', () => {
    expect(isRetryableRateLimitError({ status: 429 })).toBe(true);
    expect(isRetryableRateLimitError({ code: '429' })).toBe(true);
    expect(isRetryableRateLimitError({ errorCode: 'RESOURCE_EXHAUSTED' })).toBe(
      true,
    );
    expect(
      isRetryableRateLimitError(new Error('Rate limit exceeded, slow down')),
    ).toBe(true);
    expect(isRetryableRateLimitError(new Error('429 Too Many Requests'))).toBe(
      true,
    );
  });

  it('detects transient 5xx and transport failures', () => {
    expect(
      isTransientLlmError(
        Object.assign(new Error('Service Unavailable'), { status: 503 }),
      ),
    ).toBe(true);
    expect(isTransientLlmError({ statusCode: 500 })).toBe(true);
    expect(isTransientLlmError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientLlmError({ errorCode: 'DEADLINE_EXCEEDED' })).toBe(true);
    expect(isTransientLlmError(new Error('socket hang up'))).toBe(true);
    expect(isTransientLlmError(new Error('fetch failed'))).toBe(true);
    expect(isTransientLlmError(new Error('request timed out'))).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(
      isRetryableLlmError(
        Object.assign(new Error('Invalid API key'), { status: 400 }),
      ),
    ).toBe(false);
    expect(isRetryableLlmError({ status: 404 })).toBe(false);
    expect(isRetryableLlmError(undefined)).toBe(false);
    expect(isTransientLlmError(new Error('Invalid API key'))).toBe(false);
  });

  it('detects retryable error responses (429 family and 5xx)', () => {
    expect(isRetryableRateLimitResponse(rateLimitResponse)).toBe(true);
    expect(isRetryableRateLimitResponse(unavailableResponse)).toBe(false);
    expect(isRetryableLlmResponse(rateLimitResponse)).toBe(true);
    expect(isRetryableLlmResponse(unavailableResponse)).toBe(true);
    expect(isRetryableLlmResponse(ok('fine'))).toBe(false);
    expect(
      isRetryableLlmResponse({
        errorCode: '400',
        errorMessage: 'INVALID_ARGUMENT',
      }),
    ).toBe(false);
  });
});

describe('RetryingLlm', () => {
  it('retries a yielded 429 error response and returns the eventual success', async () => {
    const inner = new ScriptedLlm([
      () => rateLimitResponse,
      () => rateLimitResponse,
      () => ok('done'),
    ]);
    const llm = withLlmRetry(inner, fastRetries);

    const responses = await collect(llm);

    expect(inner.attempts).toBe(3);
    expect(responses).toEqual([ok('done')]);
  });

  it('retries a thrown 429 error', async () => {
    const inner = new ScriptedLlm([
      () => {
        throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      },
      () => ok('done'),
    ]);
    const llm = new RetryingLlm(inner, fastRetries);

    const responses = await collect(llm);

    expect(inner.attempts).toBe(2);
    expect(responses).toEqual([ok('done')]);
  });

  it('retries a yielded 5xx error response', async () => {
    const inner = new ScriptedLlm([
      () => unavailableResponse,
      () => ok('recovered'),
    ]);
    const llm = new RetryingLlm(inner, fastRetries);

    const responses = await collect(llm);

    expect(inner.attempts).toBe(2);
    expect(responses).toEqual([ok('recovered')]);
  });

  it('retries transient 5xx / connection / timeout failures', async () => {
    const inner = new ScriptedLlm([
      () => {
        throw Object.assign(new Error('Service Unavailable'), { status: 503 });
      },
      () => {
        throw Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        });
      },
      () => {
        throw new Error('request timed out');
      },
      () => ok('done'),
    ]);
    const llm = new RetryingLlm(inner, fastRetries);

    const responses = await collect(llm);

    expect(inner.attempts).toBe(4);
    expect(responses).toEqual([ok('done')]);
  });

  it('gives up after maxRetries and surfaces the rate-limit error response', async () => {
    const inner = new ScriptedLlm([() => rateLimitResponse]);
    const llm = new RetryingLlm(inner, { ...fastRetries, maxRetries: 2 });

    const responses = await collect(llm);

    expect(inner.attempts).toBe(3); // initial + 2 retries
    expect(responses).toEqual([rateLimitResponse]);
  });

  it('rethrows non-retryable thrown errors without retrying', async () => {
    const inner = new ScriptedLlm([
      () => {
        throw Object.assign(new Error('Invalid API key'), { status: 400 });
      },
      () => ok('unreachable'),
    ]);
    const llm = new RetryingLlm(inner, fastRetries);

    await expect(collect(llm)).rejects.toThrow('Invalid API key');
    expect(inner.attempts).toBe(1);
  });

  it('passes non-retryable error responses through untouched', async () => {
    const badRequest: LlmResponse = {
      errorCode: '400',
      errorMessage: 'INVALID_ARGUMENT',
    };
    const inner = new ScriptedLlm([() => badRequest, () => ok('unreachable')]);
    const llm = new RetryingLlm(inner, fastRetries);

    const responses = await collect(llm);

    expect(responses).toEqual([badRequest]);
    expect(inner.attempts).toBe(1);
  });

  it('does not retry once a real content response was produced', async () => {
    const inner = new ScriptedLlm([() => ok('first')]);
    const llm = new RetryingLlm(inner, fastRetries);

    const responses = await collect(llm);

    expect(responses).toEqual([ok('first')]);
    expect(inner.attempts).toBe(1);
  });

  it('stops retrying when the abort signal fires', async () => {
    const abort = new AbortController();
    const inner = new ScriptedLlm([() => rateLimitResponse]);
    const llm = new RetryingLlm(inner, {
      ...fastRetries,
      maxRetries: 10,
    });

    const responses: LlmResponse[] = [];
    const drain = (async () => {
      for await (const response of llm.generateContentAsync(
        modelRequest(llm),
        false,
        abort.signal,
      )) {
        responses.push(response);
      }
    })();
    abort.abort();
    await drain;

    expect(inner.attempts).toBeLessThan(11);
    expect(responses).toEqual([rateLimitResponse]);
  });

  it('streams content as it arrives instead of buffering the whole response', async () => {
    const gate = createGate();
    class StreamingLlm extends BaseLlm {
      override async *generateContentAsync(): AsyncGenerator<
        LlmResponse,
        void
      > {
        yield ok('first');
        await gate.wait;
        yield ok('second');
      }
      override async connect(): Promise<BaseLlmConnection> {
        throw new Error('not supported');
      }
    }
    const llm = new RetryingLlm(new StreamingLlm({ model: 'streaming' }), {
      ...fastRetries,
    });
    const seen: LlmResponse[] = [];

    const drain = (async () => {
      for await (const response of llm.generateContentAsync(
        modelRequest(llm),
      )) {
        seen.push(response);
      }
    })();

    // The first chunk must reach the consumer before the inner stream ends.
    await vi.waitFor(() => expect(seen).toEqual([ok('first')]));
    gate.open();
    await drain;

    expect(seen).toEqual([ok('first'), ok('second')]);
  });

  it('surfaces a rate limit that arrives after content instead of retrying', async () => {
    class MidStreamLlm extends BaseLlm {
      attempts = 0;
      override async *generateContentAsync(): AsyncGenerator<
        LlmResponse,
        void
      > {
        this.attempts += 1;
        yield ok('partial');
        yield rateLimitResponse;
      }
      override async connect(): Promise<BaseLlmConnection> {
        throw new Error('not supported');
      }
    }
    const inner = new MidStreamLlm({ model: 'mid-stream' });
    const llm = new RetryingLlm(inner, { ...fastRetries, maxRetries: 5 });

    const responses = await collect(llm);

    expect(inner.attempts).toBe(1);
    expect(responses).toEqual([ok('partial'), rateLimitResponse]);
  });

  it('does not retry a transient throw after content was streamed', async () => {
    class PartialThenThrowLlm extends BaseLlm {
      attempts = 0;
      override async *generateContentAsync(): AsyncGenerator<
        LlmResponse,
        void
      > {
        this.attempts += 1;
        yield ok('partial');
        throw Object.assign(new Error('Service Unavailable'), { status: 503 });
      }
      override async connect(): Promise<BaseLlmConnection> {
        throw new Error('not supported');
      }
    }
    const inner = new PartialThenThrowLlm({ model: 'partial-throw' });
    const llm = new RetryingLlm(inner, { ...fastRetries, maxRetries: 5 });

    await expect(collect(llm)).rejects.toThrow('Service Unavailable');
    expect(inner.attempts).toBe(1);
  });

  it('retries establishing a connection on transient failures', async () => {
    class FlakyConnectLlm extends BaseLlm {
      attempts = 0;
      override async *generateContentAsync(): AsyncGenerator<
        LlmResponse,
        void
      > {
        yield ok('unused');
      }
      override async connect(): Promise<BaseLlmConnection> {
        this.attempts += 1;
        if (this.attempts < 3) {
          throw Object.assign(new Error('connection reset'), {
            code: 'ECONNRESET',
          });
        }
        return {} as BaseLlmConnection;
      }
    }
    const inner = new FlakyConnectLlm({ model: 'flaky-connect' });
    const llm = new RetryingLlm(inner, fastRetries);

    const connection = await llm.connect(modelRequest(llm));

    expect(connection).toBeDefined();
    expect(inner.attempts).toBe(3);
  });

  it('keeps the deprecated withRateLimitRetry alias working', () => {
    const llm = withRateLimitRetry(
      new ScriptedLlm([() => ok('alias')]),
      fastRetries,
    );

    expect(llm).toBeInstanceOf(RetryingLlm);
  });
});
