import assert from 'node:assert/strict';

import { Then } from '@cucumber/cucumber';

import { CoreWorld } from '../support/world.js';

Then(
  'the PR status for {string} is marked as {string}',
  async function (this: CoreWorld, prKey: string, expectedStatus: string) {
    const prState = await this.prRepository.getPRStatus(prKey);
    assert(prState !== null, `PR state for ${prKey} not found in DB`);
    assert.equal(prState.status, expectedStatus);
  },
);
