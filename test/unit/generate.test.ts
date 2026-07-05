import { describe, expect, it } from 'vitest';
import { extractJson } from '../../src/models/generate.js';

describe('extractJson', () => {
  it('parses raw JSON', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses fenced JSON surrounded by prose', () => {
    expect(extractJson('Here:\n```json\n{"a": [1, 2]}\n```\nDone.')).toEqual({ a: [1, 2] });
  });

  it('extracts an embedded object from noisy text', () => {
    expect(extractJson('noise {"a": {"b": 2}} trailing')).toEqual({ a: { b: 2 } });
  });

  it('returns undefined when nothing parses', () => {
    expect(extractJson('not json at all')).toBeUndefined();
  });
});
