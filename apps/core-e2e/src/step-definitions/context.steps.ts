import { When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
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
  'the returned context contains summary with architecture {string}',
  function (this: CoreWorld, architecture: string) {
    assert(this.lastResponse, 'No HTTP response received');
    const json = this.lastResponse.json();
    assert(json, 'Response body could not be parsed as JSON');
    assert(json.summary, 'Response JSON does not contain summary');

    let summaryObj = json.summary;
    if (typeof summaryObj === 'string') {
      try {
        summaryObj = JSON.parse(summaryObj);
      } catch {
        // Leave as string if not JSON
      }
    }

    if (typeof summaryObj === 'object' && summaryObj !== null) {
      assert.equal(summaryObj.architecture, architecture);
    } else {
      assert.fail(
        `Summary is neither object nor parseable JSON: ${json.summary}`,
      );
    }
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
