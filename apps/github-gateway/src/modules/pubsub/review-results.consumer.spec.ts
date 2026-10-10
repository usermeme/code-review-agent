import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReviewResultsConsumer } from './review-results.consumer.js';
import { EventEmitter } from 'node:events';

describe('ReviewResultsConsumer', () => {
  let mockPubSub: any;
  let mockSubscription: any;
  let mockGithubService: any;

  beforeEach(() => {
    mockSubscription = new EventEmitter();
    mockSubscription.close = vi.fn().mockResolvedValue(undefined);

    mockPubSub = {
      subscription: vi.fn().mockReturnValue(mockSubscription),
    };

    mockGithubService = {
      postReview: vi.fn().mockResolvedValue({
        success: true,
        message: 'Review posted',
        reviewId: '123',
      }),
    };
  });

  it('starts subscription and processes review result messages', async () => {
    const consumer = new ReviewResultsConsumer({
      pubsub: mockPubSub,
      subscriptionName: 'test-review-results-sub',
      githubService: mockGithubService,
    });

    consumer.start();

    expect(mockPubSub.subscription).toHaveBeenCalledWith(
      'test-review-results-sub',
    );

    const mockMessage = {
      id: 'msg-1',
      data: Buffer.from(
        JSON.stringify({
          provider: 'github',
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 42,
          summary: 'Looks good',
          comments: [
            {
              path: 'file.ts',
              position: 10,
              body: 'Nice work',
            },
          ],
        }),
      ),
      ack: vi.fn(),
      nack: vi.fn(),
    };

    mockSubscription.emit('message', mockMessage);

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockGithubService.postReview).toHaveBeenCalledWith({
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 42,
      summary: 'Looks good',
      comments: [
        {
          path: 'file.ts',
          position: 10,
          body: 'Nice work',
        },
      ],
      ticketCoverage: undefined,
    });
    expect(mockMessage.ack).toHaveBeenCalled();
  });

  it('acks and skips invalid payload messages', async () => {
    const consumer = new ReviewResultsConsumer({
      pubsub: mockPubSub,
      subscriptionName: 'test-review-results-sub',
      githubService: mockGithubService,
    });

    consumer.start();

    const mockMessage = {
      id: 'msg-2',
      data: Buffer.from(JSON.stringify({ invalid: 'payload' })),
      ack: vi.fn(),
      nack: vi.fn(),
    };

    mockSubscription.emit('message', mockMessage);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockGithubService.postReview).not.toHaveBeenCalled();
    expect(mockMessage.ack).toHaveBeenCalled();
  });

  it('stops subscription when stop is called', async () => {
    const consumer = new ReviewResultsConsumer({
      pubsub: mockPubSub,
      subscriptionName: 'test-review-results-sub',
      githubService: mockGithubService,
    });

    consumer.start();
    await consumer.stop();

    expect(mockSubscription.close).toHaveBeenCalled();
  });
});
