import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createStoreContextTool } from './store-context.tool.js';
import { EnvService } from 'env';
import { contextBuilderEnvSchema, ContextBuilderEnvService } from '../env.js';

describe('storeContextTool', () => {
  let testEnvService: ContextBuilderEnvService;
  let mockPublishMessage: any;
  let mockPubSub: any;

  beforeEach(() => {
    testEnvService = new EnvService(contextBuilderEnvSchema, {
      CORE_URL: 'http://localhost:8080',
      REVIEW_MODEL: 'gemini-2.5-pro',
      CONTEXT_READY_TOPIC: 'context-ready-topic',
    });
    mockPublishMessage = vi.fn().mockResolvedValue('msg-id-123');
    mockPubSub = {
      topic: vi.fn().mockReturnValue({
        publishMessage: mockPublishMessage,
      }),
    };
  });

  it('has correct tool name and description', () => {
    const tool = createStoreContextTool({
      envService: testEnvService,
      pubsub: mockPubSub,
    });
    expect(tool.name).toBe('store_context');
    expect(tool.description).toContain('Stores the synthesized context');
  });

  it('publishes context payload to the configured Pub/Sub topic', async () => {
    const tool = createStoreContextTool({
      envService: testEnvService,
      pubsub: mockPubSub,
    });

    const result = await (tool as any).execute({
      provider: 'github',
      owner: 'test-owner',
      repo: 'test-repo',
      prNumber: 42,
      sections: {
        architecture: 'Microservices architecture with Fastify',
        dependencies: 'Node.js, TypeScript, Vitest',
      },
    });

    expect(result).toBe('Context successfully published to Pub/Sub.');
    expect(mockPubSub.topic).toHaveBeenCalledWith('context-ready-topic');
    expect(mockPublishMessage).toHaveBeenCalledWith({
      json: {
        provider: 'github',
        owner: 'test-owner',
        repo: 'test-repo',
        prNumber: 42,
        summary: JSON.stringify({
          architecture: 'Microservices architecture with Fastify',
          dependencies: 'Node.js, TypeScript, Vitest',
        }),
      },
    });
  });

  it('defaults prNumber to 0 when not provided', async () => {
    const tool = createStoreContextTool({
      envService: testEnvService,
      pubsub: mockPubSub,
    });

    await (tool as any).execute({
      provider: 'github',
      owner: 'test-owner',
      repo: 'test-repo',
      sections: { overview: 'Repo baseline' },
    });

    expect(mockPublishMessage).toHaveBeenCalledWith({
      json: expect.objectContaining({
        prNumber: 0,
      }),
    });
  });
});
