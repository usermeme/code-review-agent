import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubService } from '../github/github.service.js';
import { GithubAppNotInstalledError } from '../github/github-auth.service.js';
import { reviewResultsPushRoutes } from './review-results-push.routes.js';

describe('reviewResultsPushRoutes', () => {
  let app: FastifyInstance;
  let mockGithubService: { postReview: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockGithubService = {
      postReview: vi.fn().mockResolvedValue({
        success: true,
        message: 'Review posted successfully',
      }),
    };

    app = Fastify({ logger: false });
    await app.register(reviewResultsPushRoutes, {
      githubService: mockGithubService as unknown as GithubService,
    });
    await app.ready();
  });

  const validPayload = {
    provider: 'github',
    owner: 'test-org',
    repo: 'test-repo',
    prNumber: 42,
    summary: 'Looks great!',
    comments: [
      {
        path: 'src/main.ts',
        position: 10,
        body: 'Consider extracting this logic.',
      },
    ],
  };

  it('processes a valid GCP Pub/Sub push message envelope', async () => {
    const envelope = {
      message: {
        attributes: {},
        data: Buffer.from(JSON.stringify(validPayload)).toString('base64'),
        messageId: 'msg-abc-123',
      },
      subscription: 'projects/test/subscriptions/review-results-sub',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/review-results',
      payload: envelope,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(mockGithubService.postReview).toHaveBeenCalledWith({
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 42,
      summary: 'Looks great!',
      comments: [
        {
          path: 'src/main.ts',
          position: 10,
          body: 'Consider extracting this logic.',
        },
      ],
    });
  });

  it('processes a direct JSON payload without envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/review-results',
      payload: validPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(mockGithubService.postReview).toHaveBeenCalled();
  });

  it('acknowledges (returns 200) with error reason when envelope is malformed to prevent infinite retries', async () => {
    const malformedEnvelope = {
      message: {
        data: Buffer.from('not valid json').toString('base64'),
        messageId: 'msg-bad',
      },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/review-results',
      payload: malformedEnvelope,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe('Malformed Pub/Sub envelope');
    expect(mockGithubService.postReview).not.toHaveBeenCalled();
  });

  it('acknowledges (returns 200) with error reason when payload structure is invalid', async () => {
    const invalidPayload = {
      owner: 'test-org',
      // missing repo and prNumber
    };

    const res = await app.inject({
      method: 'POST',
      url: '/review-results',
      payload: invalidPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe('Invalid payload structure');
    expect(mockGithubService.postReview).not.toHaveBeenCalled();
  });

  it('returns 500 when GitHub API call fails so Pub/Sub will retry', async () => {
    mockGithubService.postReview.mockRejectedValueOnce(
      new Error('GitHub API rate limit exceeded'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/review-results',
      payload: validPayload,
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('GitHub API rate limit exceeded');
  });

  it('acknowledges (returns 200) when GitHub App is not installed to prevent redelivery loops', async () => {
    mockGithubService.postReview.mockRejectedValueOnce(
      new GithubAppNotInstalledError('test-org', 'test-repo'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/review-results',
      payload: validPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe('Non-retryable failure');
    expect(body.error).toBe(
      'GitHub App is not installed on test-org/test-repo',
    );
  });
});
