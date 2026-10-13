import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContextBuildInProgressError,
  EventOrchestratorService,
} from '../../services/event-orchestrator.service.js';
import { contextBuildsPushRoutes } from './context-builds-push.routes.js';

const envelope = (data: unknown) => ({
  message: {
    data: Buffer.from(JSON.stringify(data)).toString('base64'),
    messageId: 'msg-1',
  },
  subscription: 'projects/test/subscriptions/context-builds-sub',
});

const job = {
  provider: 'github',
  owner: 'acme',
  repo: 'shop',
  mode: 'baseline',
  ref: 'main',
  pendingPrNumber: 3,
};

describe('contextBuildsPushRoutes', () => {
  let app: FastifyInstance;
  let handleContextBuildRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    handleContextBuildRequest = vi.fn().mockResolvedValue(undefined);
    app = Fastify({ logger: false });
    await app.register(contextBuildsPushRoutes, {
      orchestrator: {
        handleContextBuildRequest,
      } as unknown as EventOrchestratorService,
    });
    await app.ready();
  });

  const push = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/context-builds', payload: body });

  it('acks a processed job with 200', async () => {
    const res = await push(envelope(job));

    expect(res.statusCode).toBe(200);
    expect(handleContextBuildRequest).toHaveBeenCalledWith(
      job,
      expect.anything(),
    );
  });

  it('answers 503 so Pub/Sub retries when another build holds the lease', async () => {
    handleContextBuildRequest.mockRejectedValue(
      new ContextBuildInProgressError('github:acme:shop'),
    );

    const res = await push(envelope(job));

    expect(res.statusCode).toBe(503);
  });

  it('answers 500 so Pub/Sub retries a failed build', async () => {
    handleContextBuildRequest.mockRejectedValue(new Error('LLM down'));

    const res = await push(envelope(job));

    expect(res.statusCode).toBe(500);
  });

  it('acks an invalid job without processing it, since a retry cannot fix it', async () => {
    const res = await push(envelope({ ...job, mode: 'everything' }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: false });
    expect(handleContextBuildRequest).not.toHaveBeenCalled();
  });
});
