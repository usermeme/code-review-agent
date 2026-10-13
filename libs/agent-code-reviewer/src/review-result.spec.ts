import { describe, expect, it } from 'vitest';

import { MAX_FINDINGS, toReviewResultPayload } from './review-result.js';
import type { Finding } from './schemas/review.schema.js';

const target = {
  provider: 'github',
  owner: 'acme',
  repo: 'shop',
  prNumber: 7,
};

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  title: 'SQL injection',
  severity: 'critical',
  path: 'src/db.ts',
  startLine: 10,
  endLine: 12,
  body: 'User input is concatenated into the query.',
  confidence: 0.9,
  ...overrides,
});

describe('toReviewResultPayload', () => {
  it('maps findings to line-range comments for the given PR', () => {
    const payload = toReviewResultPayload(
      {
        summary: 'One critical issue',
        findings: [finding({ suggestion: 'db.query(sql, [id])' })],
      },
      target,
    );

    expect(payload).toEqual({
      ...target,
      summary: 'One critical issue',
      ticketCoverage: undefined,
      comments: [
        {
          path: 'src/db.ts',
          line: 12,
          startLine: 10,
          body: '### [CRITICAL] SQL injection\n\nUser input is concatenated into the query.\n\n```suggestion\ndb.query(sql, [id])\n```',
        },
      ],
    });
  });

  it('omits startLine for single-line findings', () => {
    const payload = toReviewResultPayload(
      { summary: 's', findings: [finding({ startLine: 5, endLine: 5 })] },
      target,
    );
    expect(payload.comments[0]).not.toHaveProperty('startLine');
  });

  it('drops low-confidence findings and keeps the most severe up to the cap', () => {
    const findings = [
      finding({ title: 'unsure', confidence: 0.5 }),
      ...Array.from({ length: MAX_FINDINGS }, (_, i) =>
        finding({ title: `minor ${i}`, severity: 'minor' }),
      ),
      finding({ title: 'major one', severity: 'major' }),
    ];

    const payload = toReviewResultPayload({ summary: 's', findings }, target);

    expect(payload.comments).toHaveLength(MAX_FINDINGS);
    expect(payload.comments[0].body).toContain('major one');
    expect(payload.comments.some((c) => c.body.includes('unsure'))).toBe(false);
  });
});
