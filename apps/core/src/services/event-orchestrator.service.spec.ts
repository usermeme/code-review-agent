import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventOrchestratorService } from './event-orchestrator.service.js';
import { IngestPREventRequest } from 'contracts';
import { EnvService } from 'env';
import { coreEnvSchema, CoreEnvService } from '../env.js';

describe('EventOrchestratorService', () => {
  let mockPubSub: any;
  let mockPrRepo: any;
  let mockContextRepo: any;
  let mockGatewayClient: any;
  let testEnvService: CoreEnvService;
  let publishedMessages: { topic: string; data: any }[];

  beforeEach(() => {
    testEnvService = new EnvService(coreEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      GATEWAY_URL: 'http://localhost:8080',
      PUBSUB_SECRET_TOKEN: 'test-token',
      BUILD_CONTEXT_TOPIC: 'build-context-topic',
      REVIEW_CODE_TOPIC: 'review-code-topic',
    });
    publishedMessages = [];
    mockPubSub = {
      topic: vi.fn().mockImplementation((topicName: string) => ({
        publishMessage: vi.fn().mockImplementation(async ({ json }: { json: any }) => {
          publishedMessages.push({ topic: topicName, data: json });
        }),
      })),
    };

    mockPrRepo = {
      updatePRStatus: vi.fn().mockResolvedValue(undefined),
      getPRStatus: vi.fn().mockResolvedValue(null),
    };

    mockContextRepo = {
      getContext: vi.fn().mockResolvedValue(null),
      saveContext: vi.fn().mockResolvedValue(undefined),
    };

    mockGatewayClient = {
      postReview: vi.fn().mockResolvedValue({ success: true, reviewId: '123' }),
    };
  });

  it('triggers context build when baseline context is missing', async () => {
    const orchestrator = new EventOrchestratorService({
      pubsub: mockPubSub,
      prRepository: mockPrRepo,
      contextRepository: mockContextRepo,
      gatewayClient: mockGatewayClient,
      envService: testEnvService,
    });

    const req = {
      $typeName: 'core.v1.IngestPREventRequest',
      prMeta: {
        $typeName: 'core.v1.PRMeta',
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        action: 'opened',
        title: 'Feature X',
        author: 'developer',
        branch: 'feat/x',
        body: 'Details',
        htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
        cloneUrl: 'https://github.com/test-org/test-repo.git',
        baseRef: 'main',
        isIncrementalUpdate: false,
      },
      diff: 'diff --git a/file.ts ...',
      changedFiles: ['file.ts'],
    } as unknown as IngestPREventRequest;

    const res = await orchestrator.ingestPREvent(req);

    expect(res.status).toBe('queued');
    expect(res.success).toBe(true);
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({ status: 'queued' }),
    );
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0].topic).toBe('build-context-topic');
    expect(publishedMessages[0].data.prNumber).toBe(42);
  });

  it('triggers review directly when baseline context exists', async () => {
    mockContextRepo.getContext.mockResolvedValue({
      prKey: 'github:test-org:test-repo:0',
      summary: JSON.stringify({ architecture: 'microservices' }),
      updatedAt: new Date(),
    });

    const orchestrator = new EventOrchestratorService({
      pubsub: mockPubSub,
      prRepository: mockPrRepo,
      contextRepository: mockContextRepo,
      gatewayClient: mockGatewayClient,
      envService: testEnvService,
    });

    const req = {
      $typeName: 'core.v1.IngestPREventRequest',
      prMeta: {
        $typeName: 'core.v1.PRMeta',
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        action: 'opened',
        title: 'Feature X',
        author: 'developer',
        branch: 'feat/x',
        body: 'Details',
        htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
        cloneUrl: '',
        baseRef: 'main',
        isIncrementalUpdate: false,
      },
      diff: 'diff --git a/file.ts ...',
      changedFiles: ['file.ts'],
    } as unknown as IngestPREventRequest;

    const res = await orchestrator.ingestPREvent(req);

    expect(res.status).toBe('reviewing');
    expect(res.success).toBe(true);
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({ status: 'reviewing' }),
    );
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0].topic).toBe('review-code-topic');
    expect(publishedMessages[0].data.baselineContext).toContain('microservices');
  });

  it('posts review to gateway via ConnectRPC when review results arrive', async () => {
    const orchestrator = new EventOrchestratorService({
      pubsub: mockPubSub,
      prRepository: mockPrRepo,
      contextRepository: mockContextRepo,
      gatewayClient: mockGatewayClient,
      envService: testEnvService,
    });

    await orchestrator.handleReviewResults({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 42,
      summary: 'Looks great!',
      ticketCoverage: 'All acceptance criteria met.',
      comments: [
        {
          path: 'src/file.ts',
          position: 10,
          body: 'Consider refactoring this helper',
        },
      ],
    });

    expect(mockGatewayClient.postReview).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        summary: 'Looks great!',
        comments: expect.arrayContaining([
          expect.objectContaining({
            path: 'src/file.ts',
            position: 10,
          }),
        ]),
      }),
    );
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({ status: 'completed' }),
    );
  });
});
