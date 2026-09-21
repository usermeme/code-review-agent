import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { GatewayWorld } from '../support/world.js';

Given(
  'PR {string} is queued',
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
      status: 'queued',
    });
  },
);

When(
  'a PubSub push message arrives at {string} with token {string} containing:',
  async function (
    this: GatewayWorld,
    endpoint: string,
    token: string,
    dataTable: DataTable,
  ) {
    const row = dataTable.hashes()[0];
    const payload = {
      provider: row.provider,
      owner: row.owner,
      repo: row.repo,
      prNumber: parseInt(row.prNumber, 10),
      summary: JSON.stringify({ architecture: row.architecture }),
    };

    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
        messageId: 'mock-pubsub-msg-1',
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
  'a PubSub push message arrives at {string} without token',
  async function (this: GatewayWorld, endpoint: string) {
    const envelope = {
      message: {
        data: Buffer.from('{}').toString('base64'),
        messageId: 'mock-pubsub-msg-unauth',
      },
      subscription: 'projects/test-project/subscriptions/test-sub',
    };

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: endpoint,
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify(envelope),
    });
  },
);

Then(
  'repository {string} has a baseline context in the database',
  async function (this: GatewayWorld, repoFullName: string) {
    const key = `github:${repoFullName.replace('/', ':')}:0`;
    const doc = await this.contextRepository.getContext(key);
    assert(
      doc !== null,
      `Expected baseline context for ${repoFullName} (${key}) in database, but found none`,
    );
    assert(doc.summary, 'Baseline context in database is missing summary');
  },
);
