import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

import { CoreWorld } from '../support/world.js';

When(
  'a client requests GET {string}',
  async function (this: CoreWorld, path: string) {
    this.lastResponse = await this.app.inject({
      method: 'GET',
      url: path,
    });
  },
);

Then(
  'the response status is {int}',
  function (this: CoreWorld, statusCode: number) {
    assert(this.lastResponse, 'No HTTP response received');
    assert.equal(
      this.lastResponse.statusCode,
      statusCode,
      `Expected status ${statusCode} but got ${this.lastResponse.statusCode} with body: ${this.lastResponse.body}`,
    );
  },
);

Then(
  'the returned context has architecture {string}',
  function (this: CoreWorld, architecture: string) {
    assert(this.lastResponse, 'No HTTP response received');
    const json = this.lastResponse.json<{
      sections?: { architecture?: string };
    }>();
    assert.equal(json.sections?.architecture, architecture);
  },
);

Then(
  'the response service name is {string}',
  function (this: CoreWorld, expectedService: string) {
    assert(this.lastResponse, 'No HTTP response received');
    const json = this.lastResponse.json();
    assert.equal(json.service, expectedService);
  },
);
