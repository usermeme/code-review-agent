import { ReviewBudgetExceededError } from '@code-review-agent/agent-code-reviewer';
import { EnvService } from '@code-review-agent/env';
import { PREventPayload } from '@code-review-agent/shared-types';
import { PubSub } from '@google-cloud/pubsub';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { coreEnvSchema, CoreEnvService } from '../env.js';
import { ContextRepository } from '../modules/database/repositories/context.repository.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import { ReviewRunRepository } from '../modules/database/repositories/review-run.repository.js';
import { AgentService } from './agent.service.js';
import {
  EventOrchestratorDependencies,
  EventOrchestratorService,
} from './event-orchestrator.service.js';

describe('EventOrchestratorService', () => {
  let mockPubSub: { topic: ReturnType<typeof vi.fn> };
  let mockPrRepo: {
    updatePRStatus: ReturnType<typeof vi.fn>;
    getPRStatus: ReturnType<typeof vi.fn>;
  };
  let mockContextRepo: {
    getContext: ReturnType<typeof vi.fn>;
    saveContext: ReturnType<typeof vi.fn>;
  };
  let mockReviewRunRepo: {
    acquire: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
  };
  let testEnvService: CoreEnvService;
  let publishedMessages: { topic: string; data: Record<string, unknown> }[];
  let mockBuildContext: ReturnType<typeof vi.fn>;
  let mockRunReview: ReturnType<typeof vi.fn>;
  let mockAgentService: {
    buildContext: ReturnType<typeof vi.fn>;
    runReview: ReturnType<typeof vi.fn>;
  };

  function createTestOrchestrator(
    overrides: Partial<EventOrchestratorDependencies> = {},
  ): EventOrchestratorService {
    return new EventOrchestratorService({
      envService: testEnvService,
      prRepository: mockPrRepo as unknown as PrRepository,
      contextRepository: mockContextRepo as unknown as ContextRepository,
      reviewRunRepository: mockReviewRunRepo as unknown as ReviewRunRepository,
      pubsub: mockPubSub as unknown as PubSub,
      agentService: mockAgentService as unknown as AgentService,
      ...overrides,
    });
  }

  beforeEach(() => {
    testEnvService = new EnvService(coreEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      REVIEW_RESULTS_TOPIC: 'test-review-results-topic',
      GIT_ADAPTER_URL: 'http://adapter:8080',
      LLM_PROVIDER: 'mock',
      REVIEW_MODEL: 'test-model',
    });
    publishedMessages = [];
    mockPubSub = {
      topic: vi.fn().mockImplementation((topicName: string) => ({
        publishMessage: vi
          .fn()
          .mockImplementation(
            async ({ json }: { json: Record<string, unknown> }) => {
              publishedMessages.push({ topic: topicName, data: json });
            },
          ),
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

    mockReviewRunRepo = {
      acquire: vi.fn().mockResolvedValue({ acquired: true, attempt: 1 }),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
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
    const orchestrator = createTestOrchestrator();

    const req = {
      prMeta: {
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
    } satisfies PREventPayload;

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

    const orchestrator = createTestOrchestrator();

    const req = {
      prMeta: {
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
    } satisfies PREventPayload;

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
    const orchestrator = createTestOrchestrator();

    const req = {
      prMeta: {
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
    } satisfies PREventPayload;

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
    const orchestrator = createTestOrchestrator();

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

  it('fetches diff and changed files from gitAdapterClient when incoming diff is empty', async () => {
    const mockAdapterClient = {
      getPRDiff: vi.fn().mockResolvedValue({
        diff: 'fetched-diff-content',
        changedFiles: ['fetched-file.ts'],
      }),
      getPRFiles: vi.fn(),
      searchCode: vi.fn(),
      getFileContent: vi.fn(),
      getRepoTarball: vi.fn(),
    };

    const orchestratorWithAdapter = createTestOrchestrator({
      gitAdapterClient: mockAdapterClient,
    });

    const req: PREventPayload = {
      prMeta: {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        title: 'Feature PR',
        author: 'developer',
        branch: 'feat/test',
        htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
        action: 'opened',
      },
      diff: '',
      changedFiles: [],
    };

    const result = await orchestratorWithAdapter.ingestPREvent(req);

    expect(result.success).toBe(true);
    expect(mockAdapterClient.getPRDiff).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
    );
    expect(mockRunReview).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: 'fetched-diff-content',
        changedFiles: 'fetched-file.ts',
      }),
      expect.any(Object),
    );
  });

  describe('exactly-once processing', () => {
    const reviewEvent = (overrides: Partial<PREventPayload['prMeta']> = {}) =>
      ({
        prMeta: {
          provider: 'github',
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 42,
          title: 'Feature PR',
          author: 'developer',
          branch: 'feat/test',
          htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
          action: 'synchronize',
          headSha: 'abc123',
          ...overrides,
        },
        diff: 'diff --git a/src/a.ts b/src/a.ts\n+a\n',
        changedFiles: ['src/a.ts'],
      }) satisfies PREventPayload;

    beforeEach(() => {
      mockContextRepo.getContext.mockResolvedValue({
        prKey: 'github:test-org:test-repo:0',
        summary: JSON.stringify({ architecture: 'microservices' }),
        updatedAt: new Date(),
      });
    });

    it('keys review runs by head commit and marks them completed', async () => {
      await createTestOrchestrator().ingestPREvent(reviewEvent(), undefined, {
        messageId: 'm-1',
      });

      expect(mockReviewRunRepo.acquire).toHaveBeenCalledWith(
        'github:test-org:test-repo:42@abc123',
      );
      expect(mockReviewRunRepo.complete).toHaveBeenCalledWith(
        'github:test-org:test-repo:42@abc123',
      );
    });

    it('keys manual re-reviews by message so they can re-run a revision', async () => {
      await createTestOrchestrator().ingestPREvent(
        reviewEvent({ action: 'manual_trigger' }),
        undefined,
        { messageId: 'm-7' },
      );

      expect(mockReviewRunRepo.acquire).toHaveBeenCalledWith(
        'github:test-org:test-repo:42#msg-m-7',
      );
    });

    it('acknowledges a duplicate delivery without running the review again', async () => {
      mockReviewRunRepo.acquire.mockResolvedValue({
        acquired: false,
        reason: 'in_progress',
      });

      const res = await createTestOrchestrator().ingestPREvent(reviewEvent());

      expect(res.status).toBe('duplicate');
      expect(mockRunReview).not.toHaveBeenCalled();
      expect(publishedMessages).toHaveLength(0);
    });

    it('does not rethrow permanent failures, so Pub/Sub does not redeliver', async () => {
      mockRunReview.mockRejectedValue(
        new ReviewBudgetExceededError('over budget'),
      );

      const res = await createTestOrchestrator().ingestPREvent(reviewEvent());

      expect(res).toEqual(
        expect.objectContaining({ success: false, status: 'failed' }),
      );
      expect(mockReviewRunRepo.fail).toHaveBeenCalledWith(
        'github:test-org:test-repo:42@abc123',
        expect.stringContaining('over budget'),
        false,
      );
      expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
        'github:test-org:test-repo:42',
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('rethrows transient failures so Pub/Sub redelivers', async () => {
      mockRunReview.mockRejectedValue(
        Object.assign(new Error('backend down'), { code: 'UNAVAILABLE' }),
      );

      await expect(
        createTestOrchestrator().ingestPREvent(reviewEvent()),
      ).rejects.toThrow('backend down');
      expect(mockReviewRunRepo.fail).toHaveBeenCalledWith(
        'github:test-org:test-repo:42@abc123',
        expect.any(String),
        true,
      );
    });

    it('filters the diff before storing it or reviewing it', async () => {
      const event = reviewEvent();
      event.diff += 'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n+LOCK\n';

      await createTestOrchestrator().ingestPREvent(event);

      const reviewInput = mockRunReview.mock.calls[0][0];
      expect(reviewInput.diff).toContain('+a');
      expect(reviewInput.diff).not.toContain('+LOCK');
      const storedDiffs = mockPrRepo.updatePRStatus.mock.calls
        .map(([, state]) => state.diff)
        .filter(Boolean);
      expect(storedDiffs.join('')).not.toContain('+LOCK');
    });
  });
});
