import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  AbstractPubSubConsumer,
  BaseConsumerDependencies,
} from './abstract-pubsub.consumer.js';
import { Message } from '@google-cloud/pubsub';

interface TestPayload {
  valid: boolean;
  content: string;
}

class TestConsumer extends AbstractPubSubConsumer<TestPayload> {
  protected readonly consumerName = 'TestConsumer';
  public handledPayloads: TestPayload[] = [];

  constructor(deps: BaseConsumerDependencies) {
    super(deps);
  }

  protected isValidPayload(payload: TestPayload): boolean {
    return payload.valid === true;
  }

  protected async handlePayload(payload: TestPayload): Promise<void> {
    this.handledPayloads.push(payload);
  }
}

describe('AbstractPubSubConsumer', () => {
  let mockSubscription: any;
  let mockPubSub: any;
  let mockLogger: any;

  beforeEach(() => {
    mockSubscription = new EventEmitter();
    mockSubscription.close = vi.fn().mockResolvedValue(undefined);

    mockPubSub = {
      subscription: vi.fn().mockReturnValue(mockSubscription),
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  it('subscribes and processes valid messages', async () => {
    const consumer = new TestConsumer({
      pubsub: mockPubSub,
      subscriptionName: 'test-sub',
      logger: mockLogger,
    });

    consumer.start();
    expect(mockPubSub.subscription).toHaveBeenCalledWith('test-sub');

    const message = {
      id: 'msg-1',
      data: Buffer.from(
        JSON.stringify({ valid: true, content: 'test content' }),
      ),
      ack: vi.fn(),
      nack: vi.fn(),
    } as unknown as Message;

    mockSubscription.emit('message', message);
    await new Promise((r) => setTimeout(r, 10));

    expect(consumer.handledPayloads).toEqual([
      { valid: true, content: 'test content' },
    ]);
    expect(message.ack).toHaveBeenCalled();
    expect(message.nack).not.toHaveBeenCalled();
  });

  it('acks and logs warning for invalid payload', async () => {
    const consumer = new TestConsumer({
      pubsub: mockPubSub,
      subscriptionName: 'test-sub',
      logger: mockLogger,
    });

    consumer.start();

    const message = {
      id: 'msg-2',
      data: Buffer.from(JSON.stringify({ valid: false, content: 'invalid' })),
      ack: vi.fn(),
      nack: vi.fn(),
    } as unknown as Message;

    mockSubscription.emit('message', message);
    await new Promise((r) => setTimeout(r, 10));

    expect(consumer.handledPayloads).toHaveLength(0);
    expect(message.ack).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('closes subscription on stop', async () => {
    const consumer = new TestConsumer({
      pubsub: mockPubSub,
      subscriptionName: 'test-sub',
      logger: mockLogger,
    });

    consumer.start();
    await consumer.stop();

    expect(mockSubscription.close).toHaveBeenCalled();
  });
});
