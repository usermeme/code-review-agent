import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

import { CoreWorld } from '../support/world.js';

function buildEnvelope(
  repoFullName: string,
  prNumber: number,
  action: string,
  prMetaOverrides: Record<string, unknown> = {},
) {
  const [owner, repo] = repoFullName.split('/');
  const payload = {
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
      ...prMetaOverrides,
    },
  };

  return {
    message: {
      attributes: {},
      data: Buffer.from(JSON.stringify(payload)).toString('base64'),
      messageId: `msg-${Date.now()}`,
    },
    subscription: 'projects/test/subscriptions/pr-events-sub',
  };
}

When(
  'PubSub pushes a PR event for {string} PR #{int} with action {string}',
  async function (
    this: CoreWorld,
    repoFullName: string,
    prNumber: number,
    action: string,
  ) {
    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/pubsub/pr-events',
      payload: buildEnvelope(repoFullName, prNumber, action),
    });
  },
);

When(
  'PubSub pushes a merged event for {string} PR #{int}',
  async function (this: CoreWorld, repoFullName: string, prNumber: number) {
    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/pubsub/pr-events',
      payload: buildEnvelope(repoFullName, prNumber, 'closed', {
        isIncrementalUpdate: true,
      }),
    });
  },
);

Then(
  'the push response reports status {string}',
  function (this: CoreWorld, status: string) {
    assert(this.lastResponse, 'Expected a response from push request');
    const body = this.lastResponse.json();
    assert.equal(body.success, true);
    assert.equal(body.data?.status, status);
  },
);

Then('the push request responds with HTTP 200', function (this: CoreWorld) {
  assert(this.lastResponse, 'Expected a response from push request');
  assert.equal(this.lastResponse.statusCode, 200);
});
