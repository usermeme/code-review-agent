import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildContextBuilderServer } from './app.js';
import { EnvService } from 'env';
import { contextBuilderEnvSchema, ContextBuilderEnvService } from './env.js';

describe('ContextBuilder Server (app.ts)', () => {
  let testEnvService: ContextBuilderEnvService;
  let mockRunner: any;
  let executedMessages: any[];

  beforeEach(() => {
    testEnvService = new EnvService(contextBuilderEnvSchema, {
      CORE_URL: 'http://localhost:8080',
      REVIEW_MODEL: 'gemini-2.5-pro',
      CONTEXT_READY_TOPIC: 'context-ready-topic',
      HOST: '0.0.0.0',
      PORT: '8080',
    });

    executedMessages = [];
    mockRunner = {
      runEphemeral: vi.fn().mockImplementation(async function* (params: any) {
        executedMessages.push(params);
        yield { type: 'event', text: 'Step 1 complete' };
      }),
    };
  });

  it('responds with 200 ok for healthcheck endpoints', async () => {
    const server = await buildContextBuilderServer({
      envService: testEnvService,
      runner: mockRunner,
      fastifyOptions: { logger: false },
    });

    const rootRes = await server.inject({
      method: 'GET',
      url: '/',
    });
    expect(rootRes.statusCode).toBe(200);
    expect(rootRes.json()).toEqual({
      status: 'ok',
      service: 'agent-context-builder',
    });

    const healthRes = await server.inject({
      method: 'GET',
      url: '/healthz',
    });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toEqual({
      status: 'ok',
      service: 'agent-context-builder',
    });
  });

  it('unpacks Pub/Sub push envelope and runs the agent', async () => {
    const server = await buildContextBuilderServer({
      envService: testEnvService,
      runner: mockRunner,
      fastifyOptions: { logger: false },
    });

    const payload = {
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 42,
    };
    const base64Data = Buffer.from(JSON.stringify(payload)).toString('base64');

    const res = await server.inject({
      method: 'POST',
      url: '/',
      payload: {
        message: {
          data: base64Data,
          messageId: 'msg-12345',
        },
        subscription: 'projects/test/subscriptions/build-context-sub',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(mockRunner.runEphemeral).toHaveBeenCalledTimes(1);
    expect(executedMessages).toHaveLength(1);
    expect(executedMessages[0].newMessage.parts[0].text).toBe(
      JSON.stringify(payload),
    );
  });

  it('accepts direct JSON payload as fallback', async () => {
    const server = await buildContextBuilderServer({
      envService: testEnvService,
      runner: mockRunner,
      fastifyOptions: { logger: false },
    });

    const directPayload = {
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
    };

    const res = await server.inject({
      method: 'POST',
      url: '/pubsub',
      payload: directPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(executedMessages[0].newMessage.parts[0].text).toBe(
      JSON.stringify(directPayload),
    );
  });

  it('returns 400 for empty or invalid payload', async () => {
    const server = await buildContextBuilderServer({
      envService: testEnvService,
      runner: mockRunner,
      fastifyOptions: { logger: false },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/',
      payload: null,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
    expect(mockRunner.runEphemeral).not.toHaveBeenCalled();
  });

  it('returns 500 when agent runner throws an error', async () => {
    mockRunner.runEphemeral = vi
      .fn()
      .mockRejectedValue(new Error('LLM rate limit'));

    const server = await buildContextBuilderServer({
      envService: testEnvService,
      runner: mockRunner,
      fastifyOptions: { logger: false },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/',
      payload: {
        message: {
          data: Buffer.from('{"test": true}').toString('base64'),
        },
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('Agent execution failed');
  });
});
