import assert from 'node:assert/strict';

import type { ReviewContextDoc } from '@code-review-agent/shared-types';
import { Given, Then } from '@cucumber/cucumber';

import { CoreWorld } from '../support/world.js';

Given(
  'the base branch has {string} with {string}',
  function (this: CoreWorld, path: string, content: string) {
    this.gitAdapterClient.baseFiles.set(path, content);
  },
);

Given(
  'the context builder extracts the rule {string} from {string}',
  function (this: CoreWorld, rule: string, path: string) {
    this.builderRules.push({
      id: 'rule',
      rule,
      appliesTo: [],
      severity: 'major',
      source: { path, startLine: 1 },
    });
  },
);

Then(
  'the review of {string} used a {string} context with {int} rule(s)',
  async function (
    this: CoreWorld,
    prKey: string,
    origin: string,
    ruleCount: number,
  ) {
    const state = await this.prRepository.getPRStatus(prKey);
    assert(state?.lastReview, `Expected a recorded review for ${prKey}`);
    assert.equal(state.lastReview.context?.origin, origin);
    assert.equal(state.lastReview.context?.ruleCount, ruleCount);
    assert.equal(state.lastReview.context?.selectedRules, ruleCount);
  },
);

Then(
  '{int} review context(s) is/are stored for {string}',
  function (this: CoreWorld, count: number, repoFullName: string) {
    const [owner, repo] = repoFullName.split('/');
    const docs = [
      ...(this.db.collections.get('review_contexts')?.values() ?? []),
    ] as unknown as ReviewContextDoc[];
    const forRepo = docs.filter(
      (doc) => doc.owner === owner && doc.repo === repo,
    );
    assert.equal(forRepo.length, count);
    assert(forRepo.every((doc) => doc.status === 'ready'));
  },
);
