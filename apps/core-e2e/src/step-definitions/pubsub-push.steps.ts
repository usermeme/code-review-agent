import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

import { CoreWorld } from '../support/world.js';

const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
new file mode 100644
--- /dev/null
+++ b/src/index.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

function buildEnvelope(
  repoFullName: string,
  prNumber: number,
  action: string,
  messageId: string,
  prMetaOverrides: Record<string, unknown> = {},
) {
  const [owner, repo] = repoFullName.split('/');
  const payload = {
    diff: sampleDiff,
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
      messageId,
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
      payload: buildEnvelope(
        repoFullName,
        prNumber,
        action,
        `msg-${Date.now()}`,
      ),
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

Then(
  'a review result message was published for {string} PR #{int}',
  function (this: CoreWorld, repoFullName: string, prNumber: number) {
    const [owner, repo] = repoFullName.split('/');
    const messages = this.pubsub.getMessagesByTopic(
      'test-review-results-topic',
    );
    assert(
      messages.length > 0,
      'Expected at least one message published to test-review-results-topic',
    );
    const match = messages.find((m) => {
      const json = m.json;
      return (
        json['owner'] === owner &&
        json['repo'] === repo &&
        json['prNumber'] === prNumber
      );
    });
    assert(
      match,
      `Expected a published review result for ${owner}/${repo} #${prNumber}`,
    );
  },
);
