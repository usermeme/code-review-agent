import { When, Then, DataTable } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { GithubGatewayWorld } from '../support/world.js';

When(
  'PubSub pushes review results for {string} PR #{int} with summary {string} and comments:',
  async function (
    this: GithubGatewayWorld,
    repoFullName: string,
    prNumber: number,
    summary: string,
    dataTable: DataTable,
  ) {
    const [owner, repo] = repoFullName.split('/');
    const rows = dataTable.hashes();
    const comments = rows.map((r) => ({
      path: r.path,
      position: parseInt(r.position, 10),
      body: r.body,
    }));

    const payload = {
      provider: 'github',
      owner,
      repo,
      prNumber,
      summary,
      comments,
    };

    const envelope = {
      message: {
        attributes: {},
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
        messageId: `msg-${Date.now()}`,
      },
      subscription: 'projects/test/subscriptions/review-results-sub',
    };

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/pubsub/review-results',
      payload: envelope,
    });
  },
);

Then(
  'the push request responds with HTTP 200',
  function (this: GithubGatewayWorld) {
    assert(this.lastResponse, 'Expected a response from push request');
    assert.equal(this.lastResponse.statusCode, 200);
  },
);
