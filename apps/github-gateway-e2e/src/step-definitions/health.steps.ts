import { When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { GithubGatewayWorld } from '../support/world.js';

When('a client requests GET {string}', async function (this: GithubGatewayWorld, path: string) {
  this.lastResponse = await this.app.inject({
    method: 'GET',
    url: path,
  });
});

Then('the response status is {int}', function (this: GithubGatewayWorld, statusCode: number) {
  assert(this.lastResponse, 'No HTTP response received');
  assert.equal(this.lastResponse.statusCode, statusCode);
});

Then(
  'the response service name is {string}',
  function (this: GithubGatewayWorld, expectedService: string) {
    assert(this.lastResponse, 'No HTTP response received');
    const json = this.lastResponse.json();
    assert.equal(json.service, expectedService);
  },
);
