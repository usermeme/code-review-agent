import { When, Then, DataTable } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { GithubAdapterWorld } from '../support/world.js';

When(
  'PubSub pushes review results for {string} PR #{int} with summary {string} and comments:',
  async function (
    this: GithubAdapterWorld,
    repoFullName: string,
    prNumber: number,
    summary: string,
    dataTable: DataTable,
  ) {
    const [owner, repo] = repoFullName.split('/');
    const rows = dataTable.hashes();
    const comments = rows.map((r) => ({
      path: r.path,
      position: parseInt(r.position, 10),
      body: r.body,
    }));

    const payload = {
      provider: 'github',
      owner,
      repo,
      prNumber,
      summary,
      comments,
    };

    const envelope = {
      message: {
        attributes: {},
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
        messageId: `msg-${Date.now()}`,
      },
      subscription: 'projects/test/subscriptions/review-results-sub',
    };

    this.lastResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/pubsub/review-results',
      payload: envelope,
    });
  },
);

Then(
  'the push request responds with HTTP 200',
  function (this: GithubAdapterWorld) {
    assert(this.lastResponse, 'Expected a response from push request');
    assert.equal(this.lastResponse.statusCode, 200);
  },
);

Then(
  'review summary is posted to GitHub PR #{int} containing {string}',
  function (this: GithubAdapterWorld, prNumber: number, summaryText: string) {
    const foundInReviews = this.octokit.postedReviews.some(
      (r) => r.pull_number === prNumber && r.body.includes(summaryText),
    );
    const foundInComments = this.octokit.postedIssueComments.some(
      (c) => c.issue_number === prNumber && c.body.includes(summaryText),
    );
    assert(
      foundInReviews || foundInComments,
      `Expected review summary for PR #${prNumber} containing "${summaryText}"`,
    );
  },
);

Then(
  'inline comment is posted to GitHub PR #{int} at {string} line {int}',
  function (
    this: GithubAdapterWorld,
    prNumber: number,
    path: string,
    line: number,
  ) {
    const found = this.octokit.postedComments.some(
      (c) => c.pull_number === prNumber && c.path === path && c.line === line,
    );
    assert(
      found,
      `Expected inline comment on PR #${prNumber} at ${path}:${line}`,
    );
  },
);
