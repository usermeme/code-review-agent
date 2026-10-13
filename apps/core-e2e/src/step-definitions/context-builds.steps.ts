import assert from 'node:assert/strict';

import type { ContextBuildRequest } from '@code-review-agent/shared-types';
import { Given, Then, When } from '@cucumber/cucumber';

import { CoreWorld } from '../support/world.js';

const repoRefOf = (repoFullName: string) => {
  const [owner, repo] = repoFullName.split('/');
  return { provider: 'github', owner, repo };
};

function contextBuildRequests(world: CoreWorld): ContextBuildRequest[] {
  return world.pubsub
    .getMessagesByTopic(world.envService.get('CONTEXT_BUILD_TOPIC'))
    .map((m) => m.json as unknown as ContextBuildRequest);
}

async function pushContextBuild(world: CoreWorld, req: ContextBuildRequest) {
  world.lastResponse = await world.app.inject({
    method: 'POST',
    url: '/api/v1/pubsub/context-builds',
    payload: {
      message: {
        data: Buffer.from(JSON.stringify(req)).toString('base64'),
        messageId: `ctx-${Date.now()}`,
      },
      subscription: 'projects/test/subscriptions/context-builds-sub',
    },
  });
}

Given(
  'another instance holds the context build lease for {string}',
  async function (this: CoreWorld, repoFullName: string) {
    const { owner, repo } = repoRefOf(repoFullName);
    const acquired = await this.leaseRepository.tryAcquire(
      `context-build:github:${owner}:${repo}`,
      'other-instance',
      60_000,
    );
    assert(acquired, 'Expected to acquire the lease for the test');
  },
);

Then(
  'a {word} context build is queued for {string}',
  function (this: CoreWorld, mode: string, repoFullName: string) {
    const { owner, repo } = repoRefOf(repoFullName);
    const found = contextBuildRequests(this).some(
      (r) => r.mode === mode && r.owner === owner && r.repo === repo,
    );
    assert(found, `Expected a ${mode} context build for ${repoFullName}`);
  },
);

Then('no context build is queued', function (this: CoreWorld) {
  assert.deepEqual(contextBuildRequests(this), []);
});

When(
  'Pub\\/Sub delivers the queued context build',
  async function (this: CoreWorld) {
    const requests = contextBuildRequests(this);
    assert(requests.length > 0, 'No context build was queued');
    await pushContextBuild(this, requests[requests.length - 1]);
  },
);

When(
  'Pub\\/Sub pushes a baseline context build for {string}',
  async function (this: CoreWorld, repoFullName: string) {
    await pushContextBuild(this, {
      ...repoRefOf(repoFullName),
      mode: 'baseline',
    });
  },
);

Then(
  'the push request responds with HTTP {int}',
  function (this: CoreWorld, statusCode: number) {
    assert(this.lastResponse, 'Expected a response from push request');
    assert.equal(this.lastResponse.statusCode, statusCode);
  },
);
