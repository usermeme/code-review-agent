import { describe, expect, it } from 'vitest';

import { findingSchema, priorFindingSchema } from './review.schema.js';

describe('findingSchema', () => {
  it('accepts a complete finding', () => {
    const result = findingSchema.safeParse({
      title: 'Race condition',
      severity: 'major',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 2,
      body: 'shared state mutated without lock',
      confidence: 0.8,
    });
    expect(result.success).toBe(true);
  });

  it('requires confidence within [0, 1] so the filter cannot be bypassed by omission', () => {
    expect(
      findingSchema.safeParse({
        title: 'x',
        severity: 'minor',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        body: 'b',
      }).success,
    ).toBe(false);
    expect(
      findingSchema.safeParse({
        title: 'x',
        severity: 'minor',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        body: 'b',
        confidence: 1.5,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown severities', () => {
    expect(
      findingSchema.safeParse({
        title: 'x',
        severity: 'blocker',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        body: 'b',
        confidence: 0.9,
      }).success,
    ).toBe(false);
  });
});

describe('priorFindingSchema', () => {
  it('accepts a valid prior finding', () => {
    const result = priorFindingSchema.safeParse({
      path: 'src/a.ts',
      startLine: 1,
      endLine: 5,
      severity: 'critical',
      title: 'SQL injection',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid fields or unknown severities', () => {
    expect(
      priorFindingSchema.safeParse({
        path: 'src/a.ts',
        startLine: 1.5,
        endLine: 5,
        severity: 'critical',
        title: 'SQL injection',
      }).success,
    ).toBe(false);

    expect(
      priorFindingSchema.safeParse({
        path: 'src/a.ts',
        startLine: 1,
        endLine: 5,
        severity: 'unknown',
        title: 'SQL injection',
      }).success,
    ).toBe(false);
  });
});
