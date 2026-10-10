import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GithubService } from './github.service.js';
import { EnvService } from 'env';
import { gatewayEnvSchema, GatewayEnvService } from '../../env.js';

describe('GithubService', () => {
  let mockPubSub: any;
  let mockOctokit: any;
  let testEnvService: GatewayEnvService;
  let publishedMessages: { topic: string; data: any }[];

  beforeEach(() => {
    testEnvService = new EnvService(gatewayEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      GITHUB_WEBHOOK_SECRET: 'test-secret',
      GITHUB_TOKEN: 'test-token',
      PR_EVENTS_TOPIC: 'test-pr-events-topic',
      REVIEW_RESULTS_SUBSCRIPTION: 'test-review-results-sub',
    });
    publishedMessages = [];
    mockPubSub = {
      topic: vi.fn().mockImplementation((topicName: string) => ({
        publishMessage: vi
          .fn()
          .mockImplementation(async ({ json }: { json: any }) => {
            publishedMessages.push({ topic: topicName, data: json });
          }),
      })),
    };

    mockOctokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              title: 'Test PR',
              body: 'Test body',
              head: { ref: 'feat/test', sha: 'commit-sha-123' },
              user: { login: 'dev-user' },
            },
          }),
          listFiles: vi.fn().mockResolvedValue({
            data: [{ filename: 'src/index.ts' }],
          }),
          createReview: vi.fn().mockResolvedValue({
            data: { id: 999 },
          }),
          createReviewComment: vi.fn().mockResolvedValue({
            data: { id: 888 },
          }),
        },
      },
    };
  });

  it('processWebhook publishes PR opened event to PubSub topic', async () => {
    const service = new GithubService({
      pubsub: mockPubSub,
      octokit: mockOctokit,
      envService: testEnvService,
    });
    const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as any;

    const payload = {
      action: 'opened',
      repository: {
        name: 'my-repo',
        owner: { login: 'my-org' },
      },
      pull_request: {
        number: 10,
        title: 'New Feature',
        body: 'Description',
        html_url: 'https://github.com/my-org/my-repo/pull/10',
        head: { ref: 'feat/new' },
        user: { login: 'alice' },
      },
    };

    const res = await service.processWebhook(
      { 'x-github-event': 'pull_request' },
      payload,
      mockLogger,
    );

    expect(res.ignored).toBe(false);
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0].topic).toBe('test-pr-events-topic');
    expect(publishedMessages[0].data).toEqual(
      expect.objectContaining({
        prMeta: expect.objectContaining({
          provider: 'github',
          owner: 'my-org',
          repo: 'my-repo',
          prNumber: 10,
          action: 'opened',
        }),
      }),
    );
  });

  it('postReview creates formal review and inline comments via Octokit', async () => {
    const service = new GithubService({
      pubsub: mockPubSub,
      octokit: mockOctokit,
      envService: testEnvService,
    });

    const result = await service.postReview({
      owner: 'my-org',
      repo: 'my-repo',
      prNumber: 10,
      summary: 'LGTM!',
      ticketCoverage: '100%',
      comments: [
        {
          path: 'src/index.ts',
          position: 5,
          body: 'Check error handling',
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.reviewId).toBe('999');
    expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'my-org',
        repo: 'my-repo',
        pull_number: 10,
        commit_id: 'commit-sha-123',
      }),
    );
    expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'my-org',
        repo: 'my-repo',
        pull_number: 10,
        path: 'src/index.ts',
        line: 5,
        commit_id: 'commit-sha-123',
      }),
    );
  });
});
