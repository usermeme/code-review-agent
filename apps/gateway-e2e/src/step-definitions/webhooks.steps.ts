import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { GatewayWorld } from '../support/world.js';

Given(
  'repository {string} has no baseline context',
  async function (this: GatewayWorld, repoFullName: string) {
    const key = `github:${repoFullName.replace('/', ':')}:0`;
    const doc = await this.contextRepository.getContext(key);
    assert.equal(doc, null);
  },
);

Given(
  'repository {string} has a baseline context with architecture {string}',
  async function (
    this: GatewayWorld,
    repoFullName: string,
    architecture: string,
  ) {
    const key = `github:${repoFullName.replace('/', ':')}:0`;
    await this.contextRepository.saveContext(key, {
      summary: JSON.stringify({ architecture }),
    });
  },
);

When(
  'GitHub sends a {string} event for {string} PR #{int} with action {string}',
  async function (
    this: GatewayWorld,
    eventName: string,
    repoFullName: string,
    prNumber: number,
    action: string,
  ) {
    const [owner, repo] = repoFullName.split('/');
    const payload = {
      action,
      pull_request: {
        number: prNumber,
        html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        title: `Feature for ${repo} #${prNumber}`,
        body: 'PR test body',
        user: { login: 'octocat' },
        head: { ref: 'feature-branch' },
        base: {
          ref: 'main',
          repo: { clone_url: `https://github.com/${owner}/${repo}.git` },
        },
      },
      repository: {
        name: repo,
        owner: { login: owner },
      },
    };

    const rawBody = JSON.stringify(payload);
    const signature = this.createHmacSignature(rawBody);

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-event': eventName,
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });
  },
);

When(
  'GitHub sends a merged PR event for {string} PR #{int}',
  async function (this: GatewayWorld, repoFullName: string, prNumber: number) {
    const [owner, repo] = repoFullName.split('/');
    const payload = {
      action: 'closed',
      pull_request: {
        number: prNumber,
        merged: true,
        html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        title: `Merged PR #${prNumber}`,
        body: 'Merged PR description',
        user: { login: 'octocat' },
        head: { ref: 'feature-branch' },
        base: {
          ref: 'main',
          repo: { clone_url: `https://github.com/${owner}/${repo}.git` },
        },
      },
      repository: {
        name: repo,
        owner: { login: owner },
      },
    };

    const rawBody = JSON.stringify(payload);
    const signature = this.createHmacSignature(rawBody);

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });
  },
);

When(
  'GitHub sends an issue comment on PR #{int} with body {string}',
  async function (this: GatewayWorld, prNumber: number, commentBody: string) {
    const owner = 'usermeme';
    const repo = 'test-repo';
    const payload = {
      action: 'created',
      issue: {
        number: prNumber,
        html_url: `https://github.com/${owner}/${repo}/issues/${prNumber}`,
        pull_request: {
          html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        },
      },
      comment: {
        body: commentBody,
      },
      repository: {
        name: repo,
        owner: { login: owner },
      },
    };

    const rawBody = JSON.stringify(payload);
    const signature = this.createHmacSignature(rawBody);

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });
  },
);

When(
  'GitHub sends a webhook with an invalid HMAC signature',
  async function (this: GatewayWorld) {
    const payload = { action: 'opened' };
    const rawBody = JSON.stringify(payload);

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=invalidhexsignature0123456789abcdef',
      },
      payload: rawBody,
    });
  },
);

Then(
  'the webhook response status is {int}',
  function (this: GatewayWorld, statusCode: number) {
    assert.equal(this.lastResponse?.statusCode, statusCode);
  },
);

Then(
  'a message is published to topic {string} with action {string} and prNumber {int}',
  function (
    this: GatewayWorld,
    topicName: string,
    action: string,
    prNumber: number,
  ) {
    const msgs = this.pubsub.getMessagesByTopic(topicName);
    assert(msgs.length > 0, `No messages published to topic ${topicName}`);
    const found = msgs.some(
      (m) => m.json?.action === action && m.json?.prNumber === prNumber,
    );
    assert(
      found,
      `Expected message with action=${action} and prNumber=${prNumber} not found in ${topicName}`,
    );
  },
);

Then(
  'a message is published to topic {string} with repo {string} and prNumber {int}',
  function (
    this: GatewayWorld,
    topicName: string,
    repo: string,
    prNumber: number,
  ) {
    const msgs = this.pubsub.getMessagesByTopic(topicName);
    assert(msgs.length > 0, `No messages published to topic ${topicName}`);
    const found = msgs.some(
      (m) =>
        m.json?.prMeta?.repo === repo && m.json?.prMeta?.number === prNumber,
    );
    assert(
      found,
      `Expected review message for ${repo}#${prNumber} not found in ${topicName}`,
    );
  },
);

Then(
  'a message is published to topic {string} with isIncrementalUpdate true',
  function (this: GatewayWorld, topicName: string) {
    const msgs = this.pubsub.getMessagesByTopic(topicName);
    assert(msgs.length > 0, `No messages published to topic ${topicName}`);
    const found = msgs.some((m) => m.json?.isIncrementalUpdate === true);
    assert(found, `Expected incremental update message in ${topicName}`);
  },
);

Then(
  'the PR status for {string} is marked as {string}',
  async function (this: GatewayWorld, prKey: string, expectedStatus: string) {
    const prState = await this.prRepository.getPRStatus(prKey);
    assert(prState !== null, `PR state for ${prKey} not found in DB`);
    assert.equal(prState.status, expectedStatus);
  },
);
