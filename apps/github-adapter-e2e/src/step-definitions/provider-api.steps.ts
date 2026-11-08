import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

import { GithubAdapterWorld } from '../support/world.js';

When(
  'a client requests GET {string}',
  async function (this: GithubAdapterWorld, path: string) {
    this.lastResponse = await this.app.inject({
      method: 'GET',
      url: path,
    });
  },
);

Then(
  'the response status is {int}',
  function (this: GithubAdapterWorld, statusCode: number) {
    assert(this.lastResponse, 'No HTTP response received');
    assert.equal(this.lastResponse.statusCode, statusCode);
  },
);

Then(
  'the response contains diff and changed files',
  function (this: GithubAdapterWorld) {
    assert(this.lastResponse, 'No HTTP response received');
    const json = this.lastResponse.json();
    assert(json.diff && json.diff.length > 0, 'Response missing diff');
    assert(
      Array.isArray(json.changedFiles) && json.changedFiles.length > 0,
      'Response missing changedFiles',
    );
  },
);
