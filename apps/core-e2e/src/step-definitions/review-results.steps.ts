import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { CoreWorld } from '../support/world.js';

Given(
  'PR {string} is reviewing',
  async function (this: CoreWorld, prKey: string) {
    const parts = prKey.split(':');
    const provider = parts[0];
    const owner = parts[1];
    const repo = parts[2];
    const prNumber = parseInt(parts[3], 10);

    await this.prRepository.updatePRStatus(prKey, {
      provider,
      owner,
      repo,
      prNumber,
      status: 'reviewing',
    });
  },
);

When(
  'a PubSub push message arrives at {string} with token {string} containing findings:',
  async function (
    this: CoreWorld,
    endpoint: string,
    token: string,
    dataTable: DataTable,
  ) {
    const rows = dataTable.hashes();
    const comments = rows.map((row) => ({
      path: row.path,
      position: parseInt(row.position, 10),
      body: row.body,
    }));

    const payload = {
      provider: 'github',
      owner: 'usermeme',
      repo: 'test-repo',
      prNumber: 40,
      comments,
    };

    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
        messageId: 'mock-pubsub-msg-findings',
      },
      subscription: 'projects/test-project/subscriptions/test-sub',
    };

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: `${endpoint}?token=${token}`,
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify(envelope),
    });
  },
);

When(
  'a PubSub push message arrives at {string} with token {string} containing summary {string} and findings:',
  async function (
    this: CoreWorld,
    endpoint: string,
    token: string,
    summary: string,
    dataTable: DataTable,
  ) {
    const rows = dataTable.hashes();
    const comments = rows.map((row) => ({
      path: row.path,
      position: parseInt(row.position, 10),
      body: row.body,
    }));

    const payload = {
      provider: 'github',
      owner: 'usermeme',
      repo: 'test-repo',
      prNumber: 41,
      summary,
      comments,
    };

    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
        messageId: 'mock-pubsub-msg-findings-summary',
      },
      subscription: 'projects/test-project/subscriptions/test-sub',
    };

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: `${endpoint}?token=${token}`,
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify(envelope),
    });
  },
);

When(
  'a PubSub push message arrives at {string} with token {string} containing summary {string} and zero findings',
  async function (
    this: CoreWorld,
    endpoint: string,
    token: string,
    summary: string,
  ) {
    const payload = {
      provider: 'github',
      owner: 'usermeme',
      repo: 'test-repo',
      prNumber: 42,
      summary,
      comments: [],
    };

    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
        messageId: 'mock-pubsub-msg-zero-findings',
      },
      subscription: 'projects/test-project/subscriptions/test-sub',
    };

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: `${endpoint}?token=${token}`,
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify(envelope),
    });
  },
);

Then(
  'Gateway receives PostReview RPC for {string} PR #{int} with {int} comments',
  function (
    this: CoreWorld,
    repoFullName: string,
    prNumber: number,
    expectedCount: number,
  ) {
    const [owner, repo] = repoFullName.split('/');
    const found = this.postedReviews.find(
      (r) =>
        r.owner === owner &&
        r.repo === repo &&
        r.prNumber === prNumber &&
        r.comments.length === expectedCount,
    );
    assert(
      found,
      `Expected PostReview RPC for ${repoFullName}#${prNumber} with ${expectedCount} comments. Found: ${JSON.stringify(
        this.postedReviews,
      )}`,
    );
  },
);

Then(
  'Gateway receives PostReview RPC for {string} PR #{int} with summary {string}',
  function (
    this: CoreWorld,
    repoFullName: string,
    prNumber: number,
    expectedSummary: string,
  ) {
    const [owner, repo] = repoFullName.split('/');
    const found = this.postedReviews.find(
      (r) =>
        r.owner === owner &&
        r.repo === repo &&
        r.prNumber === prNumber &&
        (r.summary?.includes(expectedSummary) ?? false),
    );
    assert(
      found,
      `Expected PostReview RPC for ${repoFullName}#${prNumber} containing "${expectedSummary}". Found: ${JSON.stringify(
        this.postedReviews,
      )}`,
    );
  },
);
