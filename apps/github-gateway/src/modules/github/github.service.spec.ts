import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GithubService } from './github.service.js';

describe('GithubService', () => {
  let mockCoreClient: any;
  let mockOctokit: any;

  beforeEach(() => {
    process.env['GIT_ADAPTER_WEBHOOK_SECRET'] = 'test-secret';
    process.env['GIT_ADAPTER_TOKEN'] = 'test-token';
    mockCoreClient = {
      ingestPREvent: vi.fn().mockResolvedValue({
        success: true,
        status: 'queued',
        message: 'Context build triggered',
      }),
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

  it('processWebhook forwards PR opened event to CoreService via ConnectRPC', async () => {
    const service = new GithubService({ coreClient: mockCoreClient, octokit: mockOctokit });
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
    expect(mockCoreClient.ingestPREvent).toHaveBeenCalledWith(
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
    const service = new GithubService({ coreClient: mockCoreClient, octokit: mockOctokit });

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
