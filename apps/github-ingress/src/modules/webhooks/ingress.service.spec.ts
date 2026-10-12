import { PubSub } from '@google-cloud/pubsub';
import { Webhooks } from '@octokit/webhooks';
import { FastifyBaseLogger } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IngressEnvService } from '../../env.js';
import {
  GithubIngressService,
  GithubIngressServiceDependencies,
} from './ingress.service.js';

describe('GithubIngressService', () => {
  let service: GithubIngressService;
  let mockPubSub: { topic: ReturnType<typeof vi.fn> };
  let mockTopic: { publishMessage: ReturnType<typeof vi.fn> };
  let mockEnvService: { get: ReturnType<typeof vi.fn> };
  let mockLogger: {
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockTopic = {
      publishMessage: vi.fn().mockResolvedValue('msg-id-123'),
    };
    mockPubSub = {
      topic: vi.fn().mockReturnValue(mockTopic),
    };
    mockEnvService = {
      get: vi.fn((key: string) => {
        if (key === 'GITHUB_WEBHOOK_SECRET') return 'test-secret';
        if (key === 'PR_EVENTS_TOPIC') return 'pr-events';
        return undefined;
      }),
    };
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    const deps: GithubIngressServiceDependencies = {
      envService: mockEnvService as unknown as IngressEnvService,
      pubsub: mockPubSub as unknown as PubSub,
      webhooks: new Webhooks({ secret: 'test-secret' }),
    };

    service = new GithubIngressService(deps);
  });

  it('publishes PR opened event to PubSub without needing a GitHub token', async () => {
    const payload = {
      action: 'opened',
      repository: { name: 'my-repo', owner: { login: 'my-org' } },
      pull_request: {
        number: 42,
        title: 'Feature PR',
        html_url: 'https://github.com/my-org/my-repo/pull/42',
        user: { login: 'octocat' },
        head: { ref: 'feat/test' },
        base: {
          ref: 'main',
          repo: { clone_url: 'https://github.com/my-org/my-repo.git' },
        },
      },
    };

    const result = await service.processWebhook(
      { 'x-github-event': 'pull_request' },
      payload,
      mockLogger as unknown as FastifyBaseLogger,
    );

    expect(result.ignored).toBe(false);
    expect(mockPubSub.topic).toHaveBeenCalledWith('pr-events');
    expect(mockTopic.publishMessage).toHaveBeenCalledWith({
      json: expect.objectContaining({
        prMeta: expect.objectContaining({
          provider: 'github',
          owner: 'my-org',
          repo: 'my-repo',
          prNumber: 42,
          action: 'opened',
        }),
      }),
    });
  });

  it('ignores unsupported events gracefully', async () => {
    const result = await service.processWebhook(
      { 'x-github-event': 'fork' },
      {},
      mockLogger as unknown as FastifyBaseLogger,
    );
    expect(result.ignored).toBe(true);
    expect(mockTopic.publishMessage).not.toHaveBeenCalled();
  });
});
