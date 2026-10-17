import {
  ReviewBudgetExceededError,
  ReviewRunError,
  ReviewTimeoutError,
} from '@code-review-agent/agent-code-reviewer';
import { describe, expect, it } from 'vitest';

import { isRetryableError } from './review-errors.js';

describe('isRetryableError', () => {
  it.each([
    ['a budget overrun', new ReviewBudgetExceededError('over')],
    ['a review timeout', new ReviewTimeoutError(1000)],
    ['an unknown run error', new ReviewRunError('UNKNOWN_ERROR', 'boom')],
    ['a plain error', new Error('boom')],
    ['a 400 response', Object.assign(new Error('bad'), { status: 400 })],
    ['a non-error value', 'boom'],
  ])('does not retry %s', (_label, error) => {
    expect(isRetryableError(error)).toBe(false);
  });

  it.each([
    ['a Gemini rate limit', new ReviewRunError('UNKNOWN_ERROR', 'got 429')],
    ['a 503 response', Object.assign(new Error('down'), { status: 503 })],
    ['a gRPC UNAVAILABLE', Object.assign(new Error('x'), { code: 14 })],
    [
      'a connection reset',
      Object.assign(new Error('x'), { code: 'ECONNRESET' }),
    ],
  ])('retries %s', (_label, error) => {
    expect(isRetryableError(error)).toBe(true);
  });
});
