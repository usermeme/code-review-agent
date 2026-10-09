import { When, Then, DataTable } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { GithubGatewayWorld } from '../support/world.js';
import type { PostReviewResult } from '../../../github-gateway/src/modules/github/interfaces/github.interface.js';

let lastReviewResult: PostReviewResult;

When(
  'Core calls PostReview RPC for {string} PR #{int} with summary {string} and comments:',
  async function (
    this: GithubGatewayWorld,
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

    lastReviewResult = await this.githubService.postReview({
      owner,
      repo,
      prNumber,
      summary,
      comments,
    });
  },
);

When(
  'Core calls PostReview RPC for {string} PR #{int} with summary {string} and zero findings',
  async function (
    this: GithubGatewayWorld,
    repoFullName: string,
    prNumber: number,
    summary: string,
  ) {
    const [owner, repo] = repoFullName.split('/');

    lastReviewResult = await this.githubService.postReview({
      owner,
      repo,
      prNumber,
      summary,
      comments: [],
    });
  },
);

Then('the PostReview RPC succeeds', function () {
  assert(lastReviewResult, 'No review result received');
  assert.equal(lastReviewResult.success, true);
});

Then(
  'review summary is posted to GitHub PR #{int} containing {string}',
  function (this: GithubGatewayWorld, prNumber: number, summaryText: string) {
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
    this: GithubGatewayWorld,
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
