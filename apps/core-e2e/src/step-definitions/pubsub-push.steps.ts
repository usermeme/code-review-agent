import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

import { CoreWorld } from '../support/world.js';

When(
  'PubSub pushes a PR event for {string} PR #{int} with action {string}',
  async function (
    this: CoreWorld,
    repoFullName: string,
    prNumber: number,
    action: string,
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
      },
    };

    const envelope = {
      message: {
        attributes: {},
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
        messageId: `msg-${Date.now()}`,
      },
      subscription: 'projects/test/subscriptions/pr-events-sub',
    };

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/pubsub/pr-events',
      payload: envelope,
    });
  },
);

Then('the push request responds with HTTP 200', function (this: CoreWorld) {
  assert(this.lastResponse, 'Expected a response from push request');
  assert.equal(this.lastResponse.statusCode, 200);
});
