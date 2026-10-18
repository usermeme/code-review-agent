import { EnvService } from '@code-review-agent/env';
import { MockLlm } from '@code-review-agent/llm';
import {
  GitAdapterContract,
  NonRetryableTaskError,
  PREventPayload,
} from '@code-review-agent/shared-types';
import { PubSub } from '@google-cloud/pubsub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { coreEnvSchema, CoreEnvService } from '../env.js';
import { BaselineLockRepository } from '../modules/database/repositories/baseline-lock.repository.js';
import { ContextRepository } from '../modules/database/repositories/context.repository.js';
import { DiscussionRepository } from '../modules/database/repositories/discussion.repository.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
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
  let testEnvService: CoreEnvService;
  let publishedMessages: { topic: string; data: Record<string, unknown> }[];
  let mockBuildContext: ReturnType<typeof vi.fn>;
  let mockRunReview: ReturnType<typeof vi.fn>;
  let mockAgentService: {
    buildContext: ReturnType<typeof vi.fn>;
    runReview: ReturnType<typeof vi.fn>;
  };
  let mockGitAdapterClient: GitAdapterContract;
  let mockLlm: MockLlm;

  function createTestOrchestrator(
    overrides: Partial<EventOrchestratorDependencies> = {},
  ): EventOrchestratorService {
    return new EventOrchestratorService({
      envService: testEnvService,
      prRepository: mockPrRepo as unknown as PrRepository,
      contextRepository: mockContextRepo as unknown as ContextRepository,
      pubsub: mockPubSub as unknown as PubSub,
      agentService: mockAgentService as unknown as AgentService,
      gitAdapterClient: mockGitAdapterClient,
      llm: mockLlm,
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

    mockGitAdapterClient = {
      getPRDiff: vi.fn(),
      getPRFiles: vi.fn(),
      searchCode: vi.fn(),
      getFileContent: vi.fn(),
      getRepoTarball: vi.fn(),
    };

    mockLlm = new MockLlm();
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

  it('refuses to publish review results whose coordinates do not match the originating event', async () => {
    const orchestrator = createTestOrchestrator();

    await expect(
      orchestrator.handleReviewResults(
        {
          provider: 'github',
          owner: 'victim-org',
          repo: 'other-repo',
          prNumber: 999,
          summary: 'Injected review',
          comments: [],
        },
        'github:test-org:test-repo:42',
      ),
    ).rejects.toThrow(/do not match the originating PR event/);

    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('publishes review results to REVIEW_RESULTS_TOPIC when review results arrive', async () => {
    const orchestrator = createTestOrchestrator();

    await orchestrator.handleReviewResults(
      {
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
      },
      'github:test-org:test-repo:42',
    );

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

  describe('baseline lock and discussion wiring', () => {
    function makeOpenedRequest(): PREventPayload {
      return {
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
    }

    it('backs the discussion tools with the repository when configured', async () => {
      const mockDiscussionRepo = {
        search: vi.fn().mockResolvedValue([]),
        store: vi.fn().mockResolvedValue(true),
      };
      mockContextRepo.getContext.mockResolvedValue({
        summary: '{"architecture":"cached"}',
      });
      const orchestrator = createTestOrchestrator({
        discussionRepository:
          mockDiscussionRepo as unknown as DiscussionRepository,
      });

      await orchestrator.ingestPREvent(makeOpenedRequest());

      expect(mockRunReview).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          searchDiscussions: expect.any(Function),
          storeDiscussion: expect.any(Function),
        }),
      );

      const options = mockRunReview.mock.calls[0][1] as {
        searchDiscussions?: (
          repo: string,
          query: string,
          limit: number,
        ) => Promise<unknown>;
        storeDiscussion?: (input: Record<string, unknown>) => Promise<unknown>;
      };
      await options.searchDiscussions?.('acme/app', 'sql injection', 5);
      expect(mockDiscussionRepo.search).toHaveBeenCalledWith(
        'acme/app',
        'sql injection',
        5,
      );
      await options.storeDiscussion?.({ repo: 'acme/app', body: 'note' });
      expect(mockDiscussionRepo.store).toHaveBeenCalledWith({
        repo: 'acme/app',
        body: 'note',
      });
    });

    describe('cross-instance baseline lock', () => {
      let mockLockRepo: {
        tryAcquire: ReturnType<typeof vi.fn>;
        release: ReturnType<typeof vi.fn>;
      };

      beforeEach(() => {
        mockLockRepo = {
          tryAcquire: vi.fn().mockResolvedValue(true),
          release: vi.fn().mockResolvedValue(undefined),
        };
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('builds under the lock and releases it afterwards', async () => {
        const orchestrator = createTestOrchestrator({
          baselineLockRepository:
            mockLockRepo as unknown as BaselineLockRepository,
        });

        await orchestrator.ingestPREvent(makeOpenedRequest());

        expect(mockBuildContext).toHaveBeenCalled();
        expect(mockLockRepo.tryAcquire).toHaveBeenCalledWith(
          'github:test-org:test-repo:0',
          expect.any(String),
        );
        expect(mockLockRepo.release).toHaveBeenCalledWith(
          'github:test-org:test-repo:0',
          expect.any(String),
        );
      });

      it('reuses the stored context while another instance holds the lock', async () => {
        mockLockRepo.tryAcquire.mockResolvedValue(false);
        mockContextRepo.getContext
          .mockResolvedValueOnce(null) // ingest's existence check
          .mockResolvedValue({ summary: '{"architecture":"built-elsewhere"}' });

        const orchestrator = createTestOrchestrator({
          baselineLockRepository:
            mockLockRepo as unknown as BaselineLockRepository,
        });

        const ingest = orchestrator.ingestPREvent(makeOpenedRequest());
        // Let the chain reach its first poll sleep, then fire it.
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(10_000);
        const res = await ingest;

        expect(mockBuildContext).not.toHaveBeenCalled();
        expect(mockRunReview).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            baselineContext: '{"architecture":"built-elsewhere"}',
          }),
        );
        expect(res.status).toBe('reviewing');
      });

      it('builds anyway after the lock wait times out', async () => {
        mockLockRepo.tryAcquire.mockResolvedValue(false);
        // The other instance's context never appears.
        const orchestrator = createTestOrchestrator({
          baselineLockRepository:
            mockLockRepo as unknown as BaselineLockRepository,
        });

        const ingest = orchestrator.ingestPREvent(makeOpenedRequest());
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
        await ingest;

        expect(mockBuildContext).toHaveBeenCalled();
        // The lock was never acquired, so there is nothing to release.
        expect(mockLockRepo.release).not.toHaveBeenCalled();
      });
    });

    it('marks PR failed and rethrows NonRetryableTaskError when getPRDiff fails with NonRetryableTaskError', async () => {
      mockGitAdapterClient.getPRDiff = vi
        .fn()
        .mockRejectedValue(
          new NonRetryableTaskError(
            'GitHub App is not installed on test-org/test-repo',
          ),
        );
      const orchestrator = createTestOrchestrator();

      await expect(
        orchestrator.ingestPREvent({
          ...makeOpenedRequest(),
          diff: '',
          changedFiles: [],
        }),
      ).rejects.toThrow(NonRetryableTaskError);

      expect(mockPrRepo.updatePRStatus).toHaveBeenLastCalledWith(
        'github:test-org:test-repo:42',
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mockBuildContext).not.toHaveBeenCalled();
      expect(mockRunReview).not.toHaveBeenCalled();
    });

    it('marks PR failed and rethrows NonRetryableTaskError when buildContext fails with NonRetryableTaskError', async () => {
      mockBuildContext.mockRejectedValueOnce(
        new NonRetryableTaskError(
          'GitHub App is not installed on test-org/test-repo',
        ),
      );
      const orchestrator = createTestOrchestrator();

      await expect(
        orchestrator.ingestPREvent(makeOpenedRequest()),
      ).rejects.toThrow(NonRetryableTaskError);

      expect(mockPrRepo.updatePRStatus).toHaveBeenLastCalledWith(
        'github:test-org:test-repo:42',
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mockRunReview).not.toHaveBeenCalled();
    });
  });
});
