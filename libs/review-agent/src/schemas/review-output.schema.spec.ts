import type { PriorFinding } from '@code-review-agent/shared-types';
import { describe, expect, it } from 'vitest';

import {
  deduplicateFindings,
  formatFindingComment,
  type ReviewFinding,
  toPriorFinding,
  toReviewCommentPayload,
} from './review-output.schema.js';

describe('review-output.schema', () => {
  const sampleFinding: ReviewFinding = {
    path: 'src/auth.ts',
    line: 42,
    startLine: 40,
    severity: 'critical',
    title: 'Missing signature verification',
    comment: 'JWT payload is decoded without verifying the signature.',
    suggestion: 'const payload = jwt.verify(token, secret);',
  };

  describe('formatFindingComment', () => {
    it('formats severity header, comment body, and suggestion fence', () => {
      const formatted = formatFindingComment(sampleFinding);

      expect(formatted).toBe(
        [
          '### [CRITICAL] Missing signature verification',
          '',
          'JWT payload is decoded without verifying the signature.',
          '',
          '```suggestion',
          'const payload = jwt.verify(token, secret);',
          '```',
        ].join('\n'),
      );
    });

    it('omits suggestion fence when suggestion is absent', () => {
      const formatted = formatFindingComment({
        ...sampleFinding,
        suggestion: undefined,
      });

      expect(formatted).toBe(
        '### [CRITICAL] Missing signature verification\n\nJWT payload is decoded without verifying the signature.',
      );
    });

    it('sanitizes surrounding code fences in suggestion', () => {
      const formatted = formatFindingComment({
        ...sampleFinding,
        suggestion: '```ts\nconst payload = jwt.verify(token, secret);\n```',
      });

      expect(formatted).toBe(
        [
          '### [CRITICAL] Missing signature verification',
          '',
          'JWT payload is decoded without verifying the signature.',
          '',
          '```suggestion',
          'const payload = jwt.verify(token, secret);',
          '```',
        ].join('\n'),
      );
    });
  });

  describe('deduplicateFindings', () => {
    it('removes duplicates within the same batch and against priorFindings', () => {
      const prior: PriorFinding[] = [
        {
          path: 'src/auth.ts',
          startLine: 39,
          endLine: 43,
          severity: 'critical',
          title: ' missing   signature verification ',
        },
      ];

      const newFinding: ReviewFinding = {
        path: 'src/db.ts',
        line: 18,
        severity: 'major',
        title: 'Unbounded query',
        comment: 'Add a LIMIT clause.',
      };

      const deduplicated = deduplicateFindings(
        [sampleFinding, newFinding, { ...newFinding }],
        prior,
      );

      expect(deduplicated).toHaveLength(1);
      expect(deduplicated[0]?.path).toBe('src/db.ts');
    });
  });

  describe('toReviewCommentPayload & toPriorFinding', () => {
    it('maps finding and resolved anchor to payload and prior finding record', () => {
      const commentPayload = toReviewCommentPayload(sampleFinding, {
        line: 42,
        startLine: 40,
      });
      expect(commentPayload).toEqual({
        path: 'src/auth.ts',
        position: 42,
        line: 42,
        startPosition: 40,
        body: formatFindingComment(sampleFinding),
      });

      const priorRecord = toPriorFinding(sampleFinding, {
        line: 42,
        startLine: 40,
      });
      expect(priorRecord).toEqual({
        path: 'src/auth.ts',
        startLine: 40,
        endLine: 42,
        severity: 'critical',
        title: 'Missing signature verification',
      });
    });
  });
});
