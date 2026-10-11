import { When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { GithubIngressWorld } from '../support/world.js';

When(
  'a client requests GET {string}',
  async function (this: GithubIngressWorld, path: string) {
    this.lastResponse = await this.app.inject({
      method: 'GET',
      url: path,
    });
  },
);

Then(
  'the response status is {int}',
  function (this: GithubIngressWorld, statusCode: number) {
    assert(this.lastResponse, 'No HTTP response received');
    assert.equal(this.lastResponse.statusCode, statusCode);
  },
);
