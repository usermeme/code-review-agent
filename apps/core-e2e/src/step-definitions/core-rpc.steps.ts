import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { CoreWorld } from '../support/world.js';
import type { IngestPREventResponse } from 'contracts';

let lastRpcResponse: IngestPREventResponse;

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

When(
  'Gateway calls IngestPREvent for {string} PR #{int} with action {string}',
  async function (
    this: CoreWorld,
    repoFullName: string,
    prNumber: number,
    action: string,
  ) {
    const [owner, repo] = repoFullName.split('/');
    lastRpcResponse = await this.coreRpcClient.ingestPREvent({
      diff: 'const x = 1;',
      changedFiles: ['src/index.ts'],
      prMeta: {
        provider: 'github',
        owner,
        repo,
        prNumber,
        title: `Feature for ${repo} #${prNumber}`,
        author: 'octocat',
        branch: 'feature-branch',
        body: 'PR test body',
        htmlUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        action,
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        baseRef: 'main',
        isIncrementalUpdate: false,
      },
    });
  },
);

When(
  'Gateway calls IngestPREvent for merged PR {string} PR #{int}',
  async function (this: CoreWorld, repoFullName: string, prNumber: number) {
    const [owner, repo] = repoFullName.split('/');
    lastRpcResponse = await this.coreRpcClient.ingestPREvent({
      diff: '',
      changedFiles: [],
      prMeta: {
        provider: 'github',
        owner,
        repo,
        prNumber,
        title: `Merged PR #${prNumber}`,
        author: 'octocat',
        branch: 'feature-branch',
        body: 'Merged PR description',
        htmlUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        action: 'closed',
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        baseRef: 'main',
        isIncrementalUpdate: true,
      },
    });
  },
);

When(
  'Gateway calls IngestPREvent for manual review on {string} PR #{int}',
  async function (this: CoreWorld, repoFullName: string, prNumber: number) {
    const [owner, repo] = repoFullName.split('/');
    lastRpcResponse = await this.coreRpcClient.ingestPREvent({
      diff: 'const y = 2;',
      changedFiles: ['src/main.ts'],
      prMeta: {
        provider: 'github',
        owner,
        repo,
        prNumber,
        title: `Manual review PR #${prNumber}`,
        author: 'octocat',
        branch: 'feature-branch',
        body: 'Manual review test body',
        htmlUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        action: 'manual_trigger',
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        baseRef: 'main',
        isIncrementalUpdate: false,
      },
    });
  },
);

Then('the IngestPREvent RPC response is accepted', function () {
  assert(lastRpcResponse, 'No RPC response received');
  assert.equal(lastRpcResponse.success, true);
  assert(
    lastRpcResponse.status === 'queued' ||
      lastRpcResponse.status === 'reviewing',
    `Expected status to be queued or reviewing, got ${lastRpcResponse.status}`,
  );
});

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
