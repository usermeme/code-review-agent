import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { prEventsPushRoutes } from './pr-events-push.routes.js';

describe('prEventsPushRoutes', () => {
  let app: FastifyInstance;
  let mockOrchestrator: any;

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
      orchestrator: mockOrchestrator,
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
