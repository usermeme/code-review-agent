import { describe, expect, it } from 'vitest';
import { parseReviewPlan } from '../../src/agents/schemas.js';

const PLAN = {
  summary: 'Looks good overall.',
  findings: [
    {
      title: 'Race condition',
      severity: 'major',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 2,
      body: 'shared state mutated without lock',
      confidence: 0.8,
    },
  ],
};

describe('parseReviewPlan', () => {
  it('parses a fenced json block with surrounding prose', () => {
    const text = `Here is the plan:\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\`\nDone.`;
    expect(parseReviewPlan(text)?.findings).toHaveLength(1);
  });

  it('parses bare JSON', () => {
    expect(parseReviewPlan(JSON.stringify(PLAN))?.summary).toBe('Looks good overall.');
  });

  it('extracts the outermost object from noisy text', () => {
    expect(parseReviewPlan(`noise ${JSON.stringify(PLAN)}`)).not.toBeNull();
  });

  it('returns null for schema violations', () => {
    expect(parseReviewPlan('{"summary": 1, "findings": []}')).toBeNull();
    expect(parseReviewPlan('not json at all')).toBeNull();
  });
});
