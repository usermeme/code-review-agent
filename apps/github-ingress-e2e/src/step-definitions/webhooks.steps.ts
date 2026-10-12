import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

import { GithubIngressWorld } from '../support/world.js';

When(
  'GitHub sends a {string} event for {string} PR #{int} with action {string}',
  async function (
    this: GithubIngressWorld,
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
  async function (
    this: GithubIngressWorld,
    repoFullName: string,
    prNumber: number,
  ) {
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
  async function (
    this: GithubIngressWorld,
    prNumber: number,
    commentBody: string,
  ) {
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
  async function (this: GithubIngressWorld) {
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
  function (this: GithubIngressWorld, statusCode: number) {
    assert(this.lastResponse, 'No HTTP response received');
    assert.equal(this.lastResponse.statusCode, statusCode);
  },
);

Then(
  'PubSub receives a PR event with action {string}, repo {string}, and prNumber {int}',
  function (
    this: GithubIngressWorld,
    action: string,
    repo: string,
    prNumber: number,
  ) {
    assert(this.ingestedEvents.length > 0, 'No PR events received by Pub/Sub');
    const event = this.ingestedEvents.find(
      (e) =>
        e.prMeta?.action === action &&
        e.prMeta?.repo === repo &&
        e.prMeta?.prNumber === prNumber,
    );
    assert(
      event,
      `Expected PR event with action=${action}, repo=${repo}, prNumber=${prNumber}. Found: ${JSON.stringify(
        this.ingestedEvents,
      )}`,
    );
  },
);

Then(
  'PubSub receives a PR event with isIncrementalUpdate true and prNumber {int}',
  function (this: GithubIngressWorld, prNumber: number) {
    assert(this.ingestedEvents.length > 0, 'No PR events received by PubSub');
    const event = this.ingestedEvents.find(
      (e) =>
        e.prMeta?.prNumber === prNumber &&
        e.prMeta?.isIncrementalUpdate === true,
    );
    assert(event, `Expected incremental update event for PR #${prNumber}`);
  },
);

Then(
  'PubSub receives a PR event with action {string} and prNumber {int}',
  function (this: GithubIngressWorld, action: string, prNumber: number) {
    assert(this.ingestedEvents.length > 0, 'No PR events received by PubSub');
    const event = this.ingestedEvents.find(
      (e) => e.prMeta?.action === action && e.prMeta?.prNumber === prNumber,
    );
    assert(event, `Expected PR event with action=${action} on PR #${prNumber}`);
  },
);

Then('PubSub receives no PR events', function (this: GithubIngressWorld) {
  assert.equal(
    this.ingestedEvents.length,
    0,
    `Expected 0 PR events, but found ${this.ingestedEvents.length}`,
  );
});
