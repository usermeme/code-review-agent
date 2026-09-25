import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { GatewayWorld } from '../support/world.js';

Given(
  'PR {string} is reviewing',
  async function (this: GatewayWorld, prKey: string) {
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
    this: GatewayWorld,
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

Then(
  'inline comment is posted to {string} PR #{int} at {string} line {int}',
  function (
    this: GatewayWorld,
    repoFullName: string,
    prNumber: number,
    path: string,
    line: number,
  ) {
    const [owner, repo] = repoFullName.split('/');
    const found = this.octokit.postedComments.some(
      (c) =>
        c.owner === owner &&
        c.repo === repo &&
        c.pull_number === prNumber &&
        c.path === path &&
        c.line === line,
    );
    assert(
      found,
      `Expected comment at ${path}:${line} on ${repoFullName}#${prNumber}, but found: ${JSON.stringify(
        this.octokit.postedComments,
      )}`,
    );
  },
);
