import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PrEventsConsumer } from './pr-events.consumer.js';
import { EventEmitter } from 'node:events';

describe('PrEventsConsumer', () => {
  let mockPubSub: any;
  let mockSubscription: any;
  let mockOrchestrator: any;

  beforeEach(() => {
    mockSubscription = new EventEmitter();
    mockSubscription.close = vi.fn().mockResolvedValue(undefined);

    mockPubSub = {
      subscription: vi.fn().mockReturnValue(mockSubscription),
    };

    mockOrchestrator = {
      ingestPREvent: vi.fn().mockResolvedValue({
        success: true,
        status: 'queued',
        message: 'Context build triggered',
      }),
    };
  });

  it('starts subscription and processes PR event messages', async () => {
    const consumer = new PrEventsConsumer({
      pubsub: mockPubSub,
      subscriptionName: 'test-pr-events-sub',
      orchestrator: mockOrchestrator,
    });

    consumer.start();

    expect(mockPubSub.subscription).toHaveBeenCalledWith('test-pr-events-sub');

    const mockMessage = {
      id: 'msg-1',
      data: Buffer.from(
        JSON.stringify({
          prMeta: {
            provider: 'github',
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 42,
            title: 'Test PR',
            author: 'dev',
            branch: 'feat/test',
            htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
            action: 'opened',
          },
          diff: 'diff text',
          changedFiles: ['file.ts'],
        }),
      ),
      ack: vi.fn(),
      nack: vi.fn(),
    };

    mockSubscription.emit('message', mockMessage);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockOrchestrator.ingestPREvent).toHaveBeenCalledWith(
      expect.objectContaining({
        prMeta: expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 42,
        }),
      }),
      undefined,
    );
    expect(mockMessage.ack).toHaveBeenCalled();
  });

  it('skips invalid message payloads without crashing', async () => {
    const consumer = new PrEventsConsumer({
      pubsub: mockPubSub,
      subscriptionName: 'test-pr-events-sub',
      orchestrator: mockOrchestrator,
    });

    consumer.start();

    const mockMessage = {
      id: 'msg-bad',
      data: Buffer.from(JSON.stringify({ invalid: 'data' })),
      ack: vi.fn(),
      nack: vi.fn(),
    };

    mockSubscription.emit('message', mockMessage);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockOrchestrator.ingestPREvent).not.toHaveBeenCalled();
    expect(mockMessage.ack).toHaveBeenCalled();
  });

  it('stops subscription on stop call', async () => {
    const consumer = new PrEventsConsumer({
      pubsub: mockPubSub,
      subscriptionName: 'test-pr-events-sub',
      orchestrator: mockOrchestrator,
    });

    consumer.start();
    await consumer.stop();

    expect(mockSubscription.close).toHaveBeenCalled();
  });
});
