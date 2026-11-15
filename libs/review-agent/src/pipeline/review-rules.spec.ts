import type { PRMeta } from '@code-review-agent/shared-types';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEEP_REVIEW_PATHS,
  evaluateDeepReviewPaths,
  evaluateSkipRules,
} from './review-rules.js';

const META: PRMeta = {
  provider: 'github',
  owner: 'acme',
  repo: 'payments',
  prNumber: 7,
  title: 'feat: add refunds',
  author: 'alice',
  branch: 'feat/refunds',
  htmlUrl: 'https://github.com/acme/payments/pull/7',
  action: 'opened',
};

const CODE = ['src/refunds.ts'];

describe('evaluateSkipRules', () => {
  it('lets a normal code PR through', () => {
    expect(evaluateSkipRules(META, CODE)).toBeNull();
  });

  it.each([
    ['a draft', { isDraft: true }, 'Draft'],
    ['a bot author', { author: 'dependabot[bot]' }, 'bot'],
    [
      'a skip marker in the title',
      { title: 'chore: bump [skip review]' },
      'skip',
    ],
    ['a skip marker in the body', { body: 'Trivial. [no-review]' }, 'skip'],
  ])('skips %s', (_label, override, reasonPart) => {
    const route = evaluateSkipRules({ ...META, ...override }, CODE);
    expect(route).toMatchObject({ tier: 'skip', source: 'rule' });
    expect(route?.reason).toContain(reasonPart);
  });

  it('skips a PR that only changes docs and snapshots', () => {
    const route = evaluateSkipRules(META, [
      'README.md',
      'docs/guide/setup.md',
      'src/__snapshots__/view.spec.ts.snap',
    ]);
    expect(route?.reason).toContain('documentation');
  });

  it('reviews a PR that mixes docs and code', () => {
    expect(evaluateSkipRules(META, ['README.md', 'src/refunds.ts'])).toBeNull();
  });

  it('never skips an explicit /review request', () => {
    const route = evaluateSkipRules(
      { ...META, action: 'manual_trigger', isDraft: true },
      ['README.md'],
    );
    expect(route).toBeNull();
  });
});

describe('evaluateDeepReviewPaths', () => {
  it('forces a deep review when a changed file matches a deep path', () => {
    const route = evaluateDeepReviewPaths(
      ['src/refunds.ts', 'apps/api/src/auth/session.ts'],
      DEFAULT_DEEP_REVIEW_PATHS,
    );
    expect(route).toMatchObject({ tier: 'deep', source: 'rule' });
    expect(route?.reason).toContain('apps/api/src/auth/session.ts');
  });

  it.each(['db/migrations/0042_add_refunds.ts', 'Dockerfile', 'infra/main.tf'])(
    'matches %s with the default paths',
    (path) => {
      expect(
        evaluateDeepReviewPaths([path], DEFAULT_DEEP_REVIEW_PATHS),
      ).not.toBeNull();
    },
  );

  it('returns null when nothing matches', () => {
    expect(evaluateDeepReviewPaths(CODE, DEFAULT_DEEP_REVIEW_PATHS)).toBeNull();
  });
});
