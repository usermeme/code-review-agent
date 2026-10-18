import assert from 'node:assert/strict';

import { Given, Then } from '@cucumber/cucumber';

import { CoreWorld } from '../support/world.js';

Given(
  'repository {string} has no baseline context',
  async function (this: CoreWorld, repoFullName: string) {
    const key = `github:${repoFullName.replace('/', ':')}:0`;
    const doc = await this.contextRepository.getContext(key);
    assert.equal(doc, null);
  },
);

Given(
  'repository {string} has a baseline context with architecture {string}',
  async function (this: CoreWorld, repoFullName: string, architecture: string) {
    const key = `github:${repoFullName.replace('/', ':')}:0`;
    await this.contextRepository.saveContext(key, {
      summary: JSON.stringify({ architecture }),
    });
  },
);

Then(
  'repository {string} has a baseline context in the database',
  async function (this: CoreWorld, repoFullName: string) {
    const key = `github:${repoFullName.replace('/', ':')}:0`;
    const doc = await this.contextRepository.getContext(key);
    assert(doc !== null, `Expected baseline context for ${key} to exist in DB`);
  },
);

Then(
  'a review result message is published to topic {string} with repo {string} and prNumber {int}',
  function (
    this: CoreWorld,
    topicName: string,
    repo: string,
    prNumber: number,
  ) {
    const msgs = this.pubsub.getMessagesByTopic(topicName);
    assert(msgs.length > 0, `No messages published to topic ${topicName}`);
    const found = msgs.some(
      (m) => m.json?.repo === repo && m.json?.prNumber === prNumber,
    );
    assert(
      found,
      `Expected review message for ${repo}#${prNumber} not found in ${topicName}`,
    );
  },
);

Then(
  'the PR status for {string} is marked as {string}',
  async function (this: CoreWorld, prKey: string, expectedStatus: string) {
    const prState = await this.prRepository.getPRStatus(prKey);
    assert(prState !== null, `PR state for ${prKey} not found in DB`);
    assert.equal(prState.status, expectedStatus);
  },
);
