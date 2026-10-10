import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventOrchestratorService } from './event-orchestrator.service.js';
import { IngestPREventRequest } from 'contracts';
import { EnvService } from 'env';
import { coreEnvSchema, CoreEnvService } from '../env.js';

describe('EventOrchestratorService', () => {
  let mockPubSub: any;
  let mockPrRepo: any;
  let mockContextRepo: any;
  let testEnvService: CoreEnvService;
  let publishedMessages: { topic: string; data: any }[];
  let mockBuildContext: any;
  let mockRunReview: any;
  let mockAgentService: any;

  beforeEach(() => {
    testEnvService = new EnvService(coreEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      PR_EVENTS_SUBSCRIPTION: 'test-pr-events-sub',
      REVIEW_RESULTS_TOPIC: 'test-review-results-topic',
    });
    publishedMessages = [];
    mockPubSub = {
      topic: vi.fn().mockImplementation((topicName: string) => ({
        publishMessage: vi
          .fn()
          .mockImplementation(async ({ json }: { json: any }) => {
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

    mockBuildContext = vi.fn().mockResolvedValue({
      architecture: 'In-process architecture',
      modules: 'core, gateway',
    });

    mockRunReview = vi.fn().mockResolvedValue({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 42,
      summary: 'Automated review passed',
      comments: [
        {
          path: 'src/main.ts',
          position: 5,
          body: 'Code looks clean',
        },
      ],
    });

    mockAgentService = {
      buildContext: mockBuildContext,
      runReview: mockRunReview,
    };
  });

  it('builds context and runs review in-process when baseline context is missing', async () => {
    const orchestrator = new EventOrchestratorService({
      pubsub: mockPubSub,
      prRepository: mockPrRepo,
      contextRepository: mockContextRepo,
      envService: testEnvService,
      agentService: mockAgentService,
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

    expect(res.status).toBe('reviewing');
    expect(res.success).toBe(true);
    expect(mockBuildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-org',
        repo: 'test-repo',
        isIncrementalUpdate: false,
      }),
    );
    expect(mockContextRepo.saveContext).toHaveBeenCalledWith(
      'github:test-org:test-repo:0',
      expect.objectContaining({
        summary: expect.stringContaining('In-process architecture'),
      }),
    );
    expect(mockRunReview).toHaveBeenCalledWith(
      expect.objectContaining({
        prMeta: expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          number: 42,
        }),
      }),
      expect.objectContaining({
        baselineContext: expect.stringContaining('In-process architecture'),
      }),
    );
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0].topic).toBe('test-review-results-topic');
    expect(publishedMessages[0].data.prNumber).toBe(42);
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('triggers review directly in-process when baseline context exists', async () => {
    mockContextRepo.getContext.mockResolvedValue({
      prKey: 'github:test-org:test-repo:0',
      summary: JSON.stringify({ architecture: 'microservices' }),
      updatedAt: new Date(),
    });

    const orchestrator = new EventOrchestratorService({
      pubsub: mockPubSub,
      prRepository: mockPrRepo,
      contextRepository: mockContextRepo,
      envService: testEnvService,
      agentService: mockAgentService,
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
    expect(mockBuildContext).not.toHaveBeenCalled();
    expect(mockRunReview).toHaveBeenCalledWith(
      expect.objectContaining({
        prMeta: expect.objectContaining({ number: 42 }),
      }),
      expect.objectContaining({
        baselineContext: expect.stringContaining('microservices'),
      }),
    );
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0].topic).toBe('test-review-results-topic');
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('triggers incremental context build when merged PR arrives', async () => {
    const orchestrator = new EventOrchestratorService({
      pubsub: mockPubSub,
      prRepository: mockPrRepo,
      contextRepository: mockContextRepo,
      envService: testEnvService,
      agentService: mockAgentService,
    });

    const req = {
      $typeName: 'core.v1.IngestPREventRequest',
      prMeta: {
        $typeName: 'core.v1.PRMeta',
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        action: 'closed',
        title: 'Feature X',
        author: 'developer',
        branch: 'feat/x',
        body: 'Details',
        htmlUrl: '',
        cloneUrl: '',
        baseRef: 'main',
        isIncrementalUpdate: true,
      },
      diff: '',
      changedFiles: [],
    } as unknown as IngestPREventRequest;

    const res = await orchestrator.ingestPREvent(req);

    expect(res.status).toBe('queued');
    expect(mockBuildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        isIncrementalUpdate: true,
        prNumber: 42,
      }),
    );
    expect(mockContextRepo.saveContext).toHaveBeenCalledWith(
      'github:test-org:test-repo:0',
      expect.objectContaining({
        summary: expect.stringContaining('In-process architecture'),
      }),
    );
    expect(mockRunReview).not.toHaveBeenCalled();
  });

  it('publishes review results to REVIEW_RESULTS_TOPIC when review results arrive', async () => {
    const orchestrator = new EventOrchestratorService({
      pubsub: mockPubSub,
      prRepository: mockPrRepo,
      contextRepository: mockContextRepo,
      envService: testEnvService,
      agentService: mockAgentService,
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

    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0].topic).toBe('test-review-results-topic');
    expect(publishedMessages[0].data).toEqual(
      expect.objectContaining({
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        summary: 'Looks great!',
        ticketCoverage: 'All acceptance criteria met.',
        comments: expect.arrayContaining([
          expect.objectContaining({
            path: 'src/file.ts',
            position: 10,
            body: 'Consider refactoring this helper',
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
