import { NonRetryableTaskError } from '@code-review-agent/shared-types';
import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { DeliveryRepository } from '../database/repositories/delivery.repository.js';
import { prEventsPushRoutes } from './pr-events-push.routes.js';

describe('prEventsPushRoutes', () => {
  let app: FastifyInstance;
  let mockOrchestrator: { ingestPREvent: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockOrchestrator = {
      ingestPREvent: vi.fn().mockResolvedValue({
        success: true,
        status: 'reviewing',
        message: 'Review completed',
      }),
    };

    app = Fastify({ logger: false });
    await app.register(prEventsPushRoutes, {
      orchestrator: mockOrchestrator as unknown as EventOrchestratorService,
    });
    await app.ready();
  });

  const validPayload = {
    prMeta: {
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 101,
      title: 'Fix issue',
      action: 'opened',
    },
    diff: 'diff text',
    changedFiles: ['src/app.ts'],
  };

  it('processes a valid GCP Pub/Sub push message envelope', async () => {
    const envelope = {
      message: {
        attributes: {},
        data: Buffer.from(JSON.stringify(validPayload)).toString('base64'),
        messageId: 'msg-999',
      },
      subscription: 'projects/test/subscriptions/pr-events-sub',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: envelope,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(mockOrchestrator.ingestPREvent).toHaveBeenCalledWith(
      validPayload,
      expect.anything(),
    );
  });

  it('processes a direct JSON payload without envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: validPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(mockOrchestrator.ingestPREvent).toHaveBeenCalledWith(
      validPayload,
      expect.anything(),
    );
  });

  it('acknowledges (returns 200) with error reason when envelope is malformed to prevent infinite retries', async () => {
    const malformedEnvelope = {
      message: {
        data: Buffer.from('not json').toString('base64'),
        messageId: 'msg-bad',
      },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: malformedEnvelope,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe('Malformed Pub/Sub envelope');
    expect(mockOrchestrator.ingestPREvent).not.toHaveBeenCalled();
  });

  it('acknowledges (returns 200) with error reason when payload structure is invalid', async () => {
    const invalidPayload = {
      prMeta: {
        // missing owner & repo
        prNumber: 101,
      },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: invalidPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe('Invalid payload structure');
    expect(mockOrchestrator.ingestPREvent).not.toHaveBeenCalled();
  });

  it('returns 500 on orchestrator failure so Pub/Sub retries', async () => {
    mockOrchestrator.ingestPREvent.mockRejectedValueOnce(
      new Error('Firestore connection timeout'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: validPayload,
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Firestore connection timeout');
  });
});

describe('prEventsPushRoutes delivery dedup and poison handling', () => {
  let app: FastifyInstance;
  let mockOrchestrator: { ingestPREvent: ReturnType<typeof vi.fn> };
  let mockDeliveryRepo: {
    claim: ReturnType<typeof vi.fn>;
    markDone: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };

  const validPayload = {
    prMeta: {
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 101,
      action: 'opened',
    },
    diff: 'diff text',
    changedFiles: ['src/app.ts'],
  };

  const envelope = (messageId: string) => ({
    message: {
      data: Buffer.from(JSON.stringify(validPayload)).toString('base64'),
      messageId,
    },
    subscription: 'projects/test/subscriptions/pr-events-sub',
  });

  beforeEach(async () => {
    mockOrchestrator = {
      ingestPREvent: vi.fn().mockResolvedValue({
        success: true,
        status: 'reviewing',
        message: 'Review completed',
      }),
    };
    mockDeliveryRepo = {
      claim: vi.fn().mockResolvedValue(true),
      markDone: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };

    app = Fastify({ logger: false });
    await app.register(prEventsPushRoutes, {
      orchestrator: mockOrchestrator as unknown as EventOrchestratorService,
      deliveryRepository: mockDeliveryRepo as unknown as DeliveryRepository,
    });
    await app.ready();
  });

  it('skips a duplicate delivery whose claim is already held', async () => {
    mockDeliveryRepo.claim.mockResolvedValueOnce(false);

    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: envelope('msg-dup'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('Duplicate delivery');
    expect(mockOrchestrator.ingestPREvent).not.toHaveBeenCalled();
  });

  it('marks the claim done after a successful run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: envelope('msg-ok'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(mockDeliveryRepo.markDone).toHaveBeenCalledWith('msg-ok');
    expect(mockDeliveryRepo.release).not.toHaveBeenCalled();
  });

  it('acks a non-retryable failure and records it instead of nacking', async () => {
    mockOrchestrator.ingestPREvent.mockRejectedValueOnce(
      new NonRetryableTaskError('No summarizable files found'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: envelope('msg-poison'),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe('Non-retryable failure');
    expect(body.error).toContain('No summarizable files found');
    expect(mockDeliveryRepo.markDone).toHaveBeenCalledWith('msg-poison');
    expect(mockDeliveryRepo.release).not.toHaveBeenCalled();
  });

  it('nacks a retryable failure and releases the claim for redelivery', async () => {
    mockOrchestrator.ingestPREvent.mockRejectedValueOnce(
      new Error('LLM endpoint timed out'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: envelope('msg-flaky'),
    });

    expect(res.statusCode).toBe(500);
    expect(mockDeliveryRepo.release).toHaveBeenCalledWith('msg-flaky');
    expect(mockDeliveryRepo.markDone).not.toHaveBeenCalled();
  });

  it('proceeds without dedup when the claim store is unavailable', async () => {
    mockDeliveryRepo.claim.mockRejectedValueOnce(
      new Error('Firestore unavailable'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/pr-events',
      payload: envelope('msg-nodeDedup'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(mockOrchestrator.ingestPREvent).toHaveBeenCalled();
  });
});
