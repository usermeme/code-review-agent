import assert from 'node:assert/strict';

import type {
  ThreadJudgmentAction,
  ThreadJudgmentDoc,
  ThreadJudgmentsPayload,
} from '@code-review-agent/shared-types';
import { Given, Then, When } from '@cucumber/cucumber';

import { CoreWorld } from '../support/world.js';
import { buildEnvelope } from './pubsub-push.steps.js';

const REVIEW_RESULTS_TOPIC = 'test-review-results-topic';

function judgmentPayloads(world: CoreWorld): ThreadJudgmentsPayload[] {
  return world.pubsub
    .getMessagesByTopic(REVIEW_RESULTS_TOPIC)
    .map((message) => message.json as unknown as ThreadJudgmentsPayload)
    .filter((payload) => payload.kind === 'thread-judgments');
}

function judgmentActions(world: CoreWorld): ThreadJudgmentAction[] {
  return judgmentPayloads(world).flatMap((payload) => payload.actions);
}

async function pushPrEvent(
  world: CoreWorld,
  repoFullName: string,
  prNumber: number,
  action: string,
  prMeta: Record<string, unknown>,
): Promise<void> {
  world.lastResponse = await world.app.inject({
    method: 'POST',
    url: '/api/v1/pubsub/pr-events',
    payload: buildEnvelope(
      repoFullName,
      prNumber,
      action,
      world.nextMessageId(),
      prMeta,
    ),
  });
}

Given(
  '{string} PR #{int} has a review thread {string} on {string} commented at commit {string}',
  function (
    this: CoreWorld,
    _repoFullName: string,
    _prNumber: number,
    threadId: string,
    path: string,
    commentSha: string,
  ) {
    this.gitAdapterClient.headFiles.set(
      path,
      'export const a = 1;\nexport const b = 2;\n',
    );
    this.gitAdapterClient.threads = [
      {
        id: threadId,
        path,
        line: 2,
        originalLine: 2,
        isResolved: true,
        isOutdated: false,
        resolvedBy: 'alice',
        comments: [
          {
            id: 'PRRC_1',
            author: 'alice',
            body: 'b must be 3.',
            originalCommitSha: commentSha,
          },
          {
            id: 'PRRC_2',
            author: 'alice',
            body: 'Fixed.',
            originalCommitSha: commentSha,
          },
        ],
      },
    ];
  },
);

Given(
  'the comment judge finds threads {string} because {string}',
  function (
    this: CoreWorld,
    verdict: 'fixed' | 'not_fixed' | 'accepted',
    reason: string,
  ) {
    this.judgeLlm.answer = { verdict, reason };
  },
);

When(
  'GitHub reports thread {string} resolved on {string} PR #{int} at head {string}',
  async function (
    this: CoreWorld,
    threadId: string,
    repoFullName: string,
    prNumber: number,
    headSha: string,
  ) {
    await pushPrEvent(this, repoFullName, prNumber, 'thread_resolved', {
      threadId,
      headSha,
    });
  },
);

When(
  '{string} PR #{int} is pushed to head {string}',
  async function (
    this: CoreWorld,
    repoFullName: string,
    prNumber: number,
    headSha: string,
  ) {
    await pushPrEvent(this, repoFullName, prNumber, 'synchronize', {
      headSha,
    });
  },
);

Then(
  'the adapter is asked to re-open thread {string} saying {string}',
  function (this: CoreWorld, threadId: string, reason: string) {
    const reopen = judgmentActions(this).find(
      (action) => action.type === 'reopen' && action.threadId === threadId,
    );
    assert(reopen?.type === 'reopen', `Expected thread ${threadId} re-opened`);
    assert(reopen.body.includes(reason), `Reply was: ${reopen.body}`);
    assert(judgmentPayloads(this).some((payload) => payload.dismissApprovals));
  },
);

Then(
  'the adapter is asked to confirm thread {string}',
  function (this: CoreWorld, threadId: string) {
    const react = judgmentActions(this).find(
      (action) => action.type === 'react' && action.threadId === threadId,
    );
    assert(react, `Expected thread ${threadId} confirmed with a reaction`);
  },
);

Then('no thread judgments are published', function (this: CoreWorld) {
  assert.deepEqual(judgmentPayloads(this), []);
});

Then(
  'the judgment of thread {string} on {string} is {string}',
  async function (
    this: CoreWorld,
    threadId: string,
    prKey: string,
    status: string,
  ) {
    const doc = await this.db.getDocument<ThreadJudgmentDoc>(
      'thread_judgments',
      `${prKey}:${threadId}`,
    );
    assert.equal(doc?.status, status);
  },
);
