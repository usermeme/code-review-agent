import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import { describe, expect, it } from 'vitest';

import type { Finding, PriorFinding } from '../schemas/review.schema.js';
import {
  buildPublishTarget,
  finalizeReview,
  type FinalizeReviewArgs,
} from './finalize-review.util.js';

const TARGET = {
  provider: 'github',
  owner: 'test-owner',
  repo: 'test-repo',
  prNumber: 42,
};

function finalize(overrides: Partial<FinalizeReviewArgs> = {}) {
  return finalizeReview({
    summary: 's',
    findings: [],
    diff: '',
    priorFindings: [],
    target: TARGET,
    ...overrides,
  });
}

describe('finalizeReview', () => {
  it('formats findings into inline review comments', () => {
    const finalized = finalize({
      summary: 'Critical security issue detected',
      findings: [
        {
          title: 'SQL Injection Vulnerability',
          severity: 'critical',
          path: 'src/db.ts',
          startLine: 10,
          endLine: 12,
          body: 'Unsanitized user input concatenated into query string.',
          confidence: 0.95,
        },
      ],
    });

    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 1 review findings and summary',
    );
    expect(finalized.payload).toEqual({
      provider: 'github',
      owner: 'test-owner',
      repo: 'test-repo',
      prNumber: 42,
      summary: 'Critical security issue detected',
      comments: [
        {
          path: 'src/db.ts',
          startPosition: 10,
          position: 12,
          body: '### [CRITICAL] SQL Injection Vulnerability\n\nUnsanitized user input concatenated into query string.',
        },
      ],
    });
  });

  it('handles a clean review with zero findings', () => {
    const finalized = finalize({
      summary: 'All checks passed cleanly',
      findings: [],
    });

    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 0 review findings',
    );
    expect(finalized.payload).toEqual(
      expect.objectContaining({
        summary: 'All checks passed cleanly',
        comments: [],
      }),
    );
  });

  it('rejects an unpublishable target as non-retryable', () => {
    expect(() => finalize({ target: { ...TARGET, prNumber: 0 } })).toThrow(
      NonRetryableTaskError,
    );
  });

  it('builds the publish target from PR meta, ignoring smuggled coordinates', () => {
    // The report schema has no coordinate fields, and the runtime builds the
    // target from the PR under review — model output cannot redirect it.
    const target = buildPublishTarget({
      provider: 'github',
      owner: 'real',
      repo: 'pr-repo',
      number: 1,
    });
    const finalized = finalize({ target, summary: 's', findings: [] });

    expect(finalized.payload).toEqual(
      expect.objectContaining({
        owner: 'real',
        repo: 'pr-repo',
        prNumber: 1,
      }),
    );
  });

  it('truncates over-long finding bodies at a word boundary', () => {
    const longBody = Array.from({ length: 400 }, (_, i) => `word${i}`).join(
      ' ',
    );
    const finalized = finalize({
      findings: [
        {
          title: 'Verbose finding',
          severity: 'major',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 2,
          body: longBody,
          confidence: 0.9,
        },
      ],
    });

    const body = finalized.payload.comments[0].body;
    expect(body.endsWith('…')).toBe(true);
    expect(body.length).toBeLessThan(longBody.length);
    expect(body.length).toBeLessThanOrEqual(
      '### [MAJOR] Verbose finding\n\n'.length + 700 + 2,
    );
    expect(body).not.toContain('word399');
  });

  it('drops low-confidence findings and keeps all valid findings below the cap', () => {
    const finding = (
      i: number,
      severity: 'critical' | 'major' | 'minor',
    ): Finding => ({
      title: `finding ${i}`,
      severity,
      path: `src/f${i}.ts`,
      startLine: i,
      endLine: i,
      body: 'body',
      confidence: 0.9,
    });

    const findings = [
      { ...finding(0, 'minor'), confidence: 0.5 }, // dropped: low confidence
      ...Array.from({ length: 20 }, (_, i) => finding(i + 1, 'major')),
    ];

    const finalized = finalize({ findings });

    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 20 review findings',
    );
    expect(finalized.acknowledgement).toContain('dropped 1 low-confidence');
    expect(finalized.acknowledgement).not.toContain('capped');
    expect(finalized.payload.comments).toHaveLength(20);
    expect(finalized.payload.comments[0].startPosition).toBeUndefined();
  });
  it('deduplicates against prior findings and returns publishedFindings', () => {
    const initialPrior: PriorFinding[] = [
      {
        path: 'src/db.ts',
        startLine: 10,
        endLine: 12,
        severity: 'critical',
        title: 'SQL Injection Vulnerability',
      },
    ];

    const findings: Finding[] = [
      // Exact title match on same path
      {
        title: 'SQL Injection Vulnerability',
        severity: 'critical',
        path: 'src/db.ts',
        startLine: 10,
        endLine: 12,
        body: 'Already reported',
        confidence: 0.95,
      },
      // Shared tokens ('injection', 'vulnerability')
      {
        title: 'Potential SQL Injection Vulnerability Flaw',
        severity: 'critical',
        path: 'src/db.ts',
        startLine: 11,
        endLine: 13,
        body: 'Shared title tokens with a prior finding',
        confidence: 0.95,
      },
      // New finding on different path
      {
        title: 'Hardcoded Secret',
        severity: 'major',
        path: 'src/auth.ts',
        startLine: 20,
        endLine: 25,
        body: 'JWT secret in source code',
        confidence: 0.9,
      },
    ];

    const finalized = finalize({
      summary: 'dedup test',
      findings,
      priorFindings: initialPrior,
    });

    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 1 review findings',
    );
    expect(finalized.acknowledgement).toContain('dropped 2 duplicate');
    expect(finalized.publishedFindings).toHaveLength(1);
    expect(finalized.publishedFindings[0]).toEqual({
      path: 'src/auth.ts',
      startLine: 20,
      endLine: 25,
      severity: 'major',
      title: 'Hardcoded Secret',
    });
  });

  it('performs intra-batch deduplication keeping highest severity/confidence finding', () => {
    const finalized = finalize({
      summary: 'intra-batch test',
      findings: [
        {
          title: 'Race Condition in Request Handler',
          severity: 'minor',
          path: 'src/service.ts',
          startLine: 7,
          endLine: 8,
          body: 'Lower severity duplicate',
          confidence: 0.8,
        },
        {
          title: 'Race Condition in Handler',
          severity: 'critical',
          path: 'src/service.ts',
          startLine: 5,
          endLine: 10,
          body: 'Higher severity finding',
          confidence: 0.95,
        },
      ],
    });

    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 1 review findings',
    );
    expect(finalized.acknowledgement).toContain('dropped 1 duplicate');
    expect(finalized.payload.comments).toHaveLength(1);
    expect(finalized.payload.comments[0].body).toContain('CRITICAL');
  });

  it('keeps distinct same-title findings that are far apart within one batch', () => {
    const finding = (startLine: number, endLine: number): Finding => ({
      title: 'Missing null check',
      severity: 'major',
      path: 'src/api.ts',
      startLine,
      endLine,
      body: `Handler at ${startLine} dereferences a nullable value`,
      confidence: 0.9,
    });

    const finalized = finalize({
      findings: [finding(10, 12), finding(250, 252)],
    });

    // Two genuinely distinct defects sharing a generic title must both
    // survive: intra-batch dedup requires line proximity.
    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 2 review findings',
    );
    expect(finalized.payload.comments).toHaveLength(2);
  });

  it('dedupes against prior findings even when line numbers shifted between runs', () => {
    const finalized = finalize({
      priorFindings: [
        {
          path: 'src/db.ts',
          startLine: 10,
          endLine: 12,
          severity: 'critical',
          title: 'SQL Injection Vulnerability',
        },
      ],
      findings: [
        {
          // Same defect, re-anchored after a new commit shifted lines.
          title: 'SQL Injection Vulnerability',
          severity: 'critical',
          path: 'src/db.ts',
          startLine: 87,
          endLine: 89,
          body: 'Query built via concatenation',
          confidence: 0.95,
        },
      ],
    });

    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 0 review findings',
    );
    expect(finalized.acknowledgement).toContain('dropped 1 duplicate');
  });

  it('does not dedupe cross-run findings that share only a single token', () => {
    const finalized = finalize({
      priorFindings: [
        {
          path: 'src/a.ts',
          startLine: 10,
          endLine: 12,
          severity: 'major',
          title: 'Memory leak',
        },
      ],
      findings: [
        {
          title: 'Leak detection disabled',
          severity: 'major',
          path: 'src/a.ts',
          startLine: 200,
          endLine: 205,
          body: 'A different problem that shares one word with the prior one',
          confidence: 0.9,
        },
      ],
    });

    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 1 review findings',
    );
  });
  it('caps runaway finding lists at the per-review limit, highest severity first', () => {
    const findings = Array.from({ length: 55 }, (_, i): Finding => ({
      title: `distinct finding ${i}`,
      severity: i < 3 ? 'critical' : 'minor',
      path: `src/f${i}.ts`,
      startLine: i + 1,
      endLine: i + 1,
      body: 'body',
      confidence: 0.9,
    }));

    const finalized = finalize({ findings });

    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 50 review findings',
    );
    expect(finalized.acknowledgement).toContain('capped 5 over-limit');
    expect(finalized.payload.comments).toHaveLength(50);
    // Severity-first ranking means the criticals survive the cap.
    expect(finalized.payload.comments[0].body).toContain('CRITICAL');
  });

  it('drops findings whose lines fall outside the diff hunks of their file', () => {
    const diff = [
      'diff --git a/src/db.ts b/src/db.ts',
      '--- a/src/db.ts',
      '+++ b/src/db.ts',
      '@@ -10,3 +10,4 @@',
      '+const q = `select ${input}`;',
    ].join('\n');

    const finalized = finalize({
      summary: 'One anchored finding, two unanchorable ones',
      diff,
      findings: [
        {
          title: 'Anchored',
          severity: 'major',
          path: 'src/db.ts',
          startLine: 11,
          endLine: 12,
          body: 'Inside the hunk.',
          confidence: 0.9,
        },
        {
          title: 'Outside hunk',
          severity: 'major',
          path: 'src/db.ts',
          startLine: 300,
          endLine: 305,
          body: 'Far from the diff.',
          confidence: 0.9,
        },
        {
          title: 'Unknown file',
          severity: 'major',
          path: 'src/other.ts',
          startLine: 1,
          endLine: 2,
          body: 'File not in the diff.',
          confidence: 0.9,
        },
      ],
    });

    expect(finalized.acknowledgement).toContain(
      'Successfully recorded 1 review findings',
    );
    expect(finalized.acknowledgement).toContain('dropped 2 unanchorable');
    expect(finalized.payload.comments).toHaveLength(1);
    expect(finalized.payload.comments[0].path).toBe('src/db.ts');
  });
});
