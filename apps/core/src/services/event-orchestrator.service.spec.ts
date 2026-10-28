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
    deletePRStatus: ReturnType<typeof vi.fn>;
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
      deletePRStatus: vi.fn().mockResolvedValue(undefined),
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
    expect(mockPrRepo.deletePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
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

  it('publishes review results to REVIEW_RESULTS_TOPIC and accumulates published findings', async () => {
    mockPrRepo.getPRStatus.mockResolvedValue({
      publishedFindings: [
        {
          path: 'src/old.ts',
          startLine: 1,
          endLine: 2,
          severity: 'minor',
          title: 'Old finding',
        },
      ],
    });

    const orchestrator = createTestOrchestrator();

    await orchestrator.handleReviewResults(
      {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        summary: 'Looks great!',
        comments: [
          {
            path: 'src/file.ts',
            position: 10,
            body: '### [MAJOR] Consider refactoring this helper\n\nHelper is too long.',
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
        comments: expect.arrayContaining([
          expect.objectContaining({
            path: 'src/file.ts',
            position: 10,
            body: '### [MAJOR] Consider refactoring this helper\n\nHelper is too long.',
          }),
        ]),
      }),
    );
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({
        status: 'completed',
        publishedFindings: [
          {
            path: 'src/old.ts',
            startLine: 1,
            endLine: 2,
            severity: 'minor',
            title: 'Old finding',
          },
          {
            path: 'src/file.ts',
            startLine: 10,
            endLine: 10,
            severity: 'major',
            title: 'Consider refactoring this helper',
          },
        ],
      }),
    );
  });

  it('omits publishedFindings when the stored PR read fails, so history is not wiped', async () => {
    mockPrRepo.getPRStatus.mockRejectedValue(
      new Error('firestore unavailable'),
    );

    const orchestrator = createTestOrchestrator();

    await orchestrator.handleReviewResults(
      {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        summary: 'Looks great!',
        comments: [
          {
            path: 'src/file.ts',
            position: 10,
            body: '### [MAJOR] Consider refactoring this helper\n\nHelper is too long.',
          },
        ],
      },
      'github:test-org:test-repo:42',
    );

    // The review still completes and is published...
    expect(publishedMessages).toHaveLength(1);
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({ status: 'completed' }),
    );
    // ...but the update must NOT carry publishedFindings: an empty/partial
    // list written after a failed read would erase the stored history.
    const completedUpdate = mockPrRepo.updatePRStatus.mock.calls.find(
      (call: unknown[]) =>
        (call[1] as { status?: string }).status === 'completed',
    );
    expect(completedUpdate?.[1]).not.toHaveProperty('publishedFindings');
  });

  it('drops malformed stored findings instead of failing the review input', async () => {
    mockPrRepo.getPRStatus.mockResolvedValue({
      publishedFindings: [
        {
          path: 'src/ok.ts',
          startLine: 1,
          endLine: 2,
          severity: 'major',
          title: 'Valid finding',
        },
        {
          path: 'src/bad.ts',
          startLine: 1.5,
          endLine: 2,
          severity: 'blocker',
          title: 'Poisoned record',
        },
      ],
    });
    mockContextRepo.getContext.mockResolvedValue({
      summary: '{"architecture":"cached"}',
    });

    const orchestrator = createTestOrchestrator();

    await orchestrator.ingestPREvent({
      prMeta: {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        action: 'synchronize',
        title: 'Feature X',
        author: 'developer',
        branch: 'feat/x',
        htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
      },
      diff: 'diff --git a/file.ts ...',
      changedFiles: ['file.ts'],
    } satisfies PREventPayload);

    expect(mockRunReview).toHaveBeenCalledWith(
      expect.objectContaining({
        priorFindings: [
          {
            path: 'src/ok.ts',
            startLine: 1,
            endLine: 2,
            severity: 'major',
            title: 'Valid finding',
          },
        ],
      }),
      expect.anything(),
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

  describe('baseline lock and prior findings wiring', () => {
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

    it('loads prior findings from stored PR and passes them into review input', async () => {
      mockContextRepo.getContext.mockResolvedValue({
        prKey: 'github:test-org:test-repo:0',
        summary: JSON.stringify({ architecture: 'microservices' }),
        updatedAt: new Date(),
      });

      const prior = [
        {
          path: 'src/db.ts',
          startLine: 10,
          endLine: 12,
          severity: 'critical' as const,
          title: 'SQL Injection',
        },
      ];

      mockPrRepo.getPRStatus.mockResolvedValue({
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        status: 'reviewing',
        updatedAt: new Date(),
        publishedFindings: prior,
      });

      const orchestrator = createTestOrchestrator();

      const req: PREventPayload = {
        prMeta: {
          provider: 'github',
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 42,
          action: 'synchronize',
          title: 'Feature X',
          author: 'developer',
          branch: 'feat/x',
          htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
        },
        diff: 'diff --git a/file.ts ...',
        changedFiles: ['file.ts'],
      };

      await orchestrator.ingestPREvent(req);

      expect(mockRunReview).toHaveBeenCalledWith(
        expect.objectContaining({
          priorFindings: prior,
        }),
        expect.anything(),
      );
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

    describe('review-failure surfacing', () => {
      it('does not publish a failure notice when the diff fetch fails before the review', async () => {
        const failingAdapter: GitAdapterContract = {
          getPRDiff: vi
            .fn()
            .mockRejectedValue(
              new NonRetryableTaskError(
                'GitHub App is not installed on test-org/test-repo',
              ),
            ),
          getPRFiles: vi.fn(),
          searchCode: vi.fn(),
          getFileContent: vi.fn(),
          getRepoTarball: vi.fn(),
        };
        const orchestrator = createTestOrchestrator({
          gitAdapterClient: failingAdapter,
        });

        await expect(
          orchestrator.ingestPREvent({
            prMeta: {
              provider: 'github',
              owner: 'test-org',
              repo: 'test-repo',
              prNumber: 42,
              action: 'opened',
              title: 'Feature X',
              author: 'developer',
              branch: 'feat/x',
              htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
            },
            diff: '',
            changedFiles: [],
          }),
        ).rejects.toThrow(NonRetryableTaskError);

        // The review never ran: the adapter failure keeps its own handling and
        // must not be reported as an abandoned review.
        expect(publishedMessages).toHaveLength(0);
        expect(mockRunReview).not.toHaveBeenCalled();
      });

      it('does not publish a failure notice when the baseline build fails before the review', async () => {
        mockContextRepo.getContext.mockResolvedValue(null);
        mockBuildContext.mockRejectedValueOnce(
          new NonRetryableTaskError('No summarizable files found'),
        );
        const orchestrator = createTestOrchestrator();

        await expect(
          orchestrator.ingestPREvent(makeOpenedRequest()),
        ).rejects.toThrow('No summarizable files found');

        expect(publishedMessages).toHaveLength(0);
        expect(mockRunReview).not.toHaveBeenCalled();
      });

      it('publishes a review-failure notice when the review fails non-retryably (e.g. timeout)', async () => {
        mockContextRepo.getContext.mockResolvedValue({
          prKey: 'github:test-org:test-repo:0',
          summary: JSON.stringify({ architecture: 'microservices' }),
          updatedAt: new Date(),
        });
        mockRunReview.mockRejectedValueOnce(
          new NonRetryableTaskError(
            'Review exceeded its 480000ms time limit and was aborted.',
          ),
        );
        const orchestrator = createTestOrchestrator();

        await expect(
          orchestrator.ingestPREvent(makeOpenedRequest()),
        ).rejects.toThrow(NonRetryableTaskError);

        // The failure must be visible on the review-results topic (the
        // adapter posts it to the PR) instead of being silently acked.
        expect(publishedMessages).toHaveLength(1);
        expect(publishedMessages[0].topic).toBe('test-review-results-topic');
        expect(publishedMessages[0].data).toEqual(
          expect.objectContaining({
            provider: 'github',
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 42,
            comments: [],
            summary: expect.stringContaining(
              'Automated code review failed and was abandoned',
            ),
            failure: {
              reason:
                'Review exceeded its 480000ms time limit and was aborted.',
            },
          }),
        );
        expect(mockPrRepo.updatePRStatus).toHaveBeenLastCalledWith(
          'github:test-org:test-repo:42',
          expect.objectContaining({ status: 'failed' }),
        );
      });

      it('does not publish a failure notice for retryable review errors (redelivery retries instead)', async () => {
        mockContextRepo.getContext.mockResolvedValue({
          prKey: 'github:test-org:test-repo:0',
          summary: JSON.stringify({ architecture: 'microservices' }),
          updatedAt: new Date(),
        });
        mockRunReview.mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED'));
        const orchestrator = createTestOrchestrator();

        await expect(
          orchestrator.ingestPREvent(makeOpenedRequest()),
        ).rejects.toThrow('RESOURCE_EXHAUSTED');

        expect(publishedMessages).toHaveLength(0);
      });

      it('never lets a failure-notice publish error mask the original failure', async () => {
        mockContextRepo.getContext.mockResolvedValue({
          prKey: 'github:test-org:test-repo:0',
          summary: JSON.stringify({ architecture: 'microservices' }),
          updatedAt: new Date(),
        });
        mockRunReview.mockRejectedValueOnce(
          new NonRetryableTaskError('Review timed out'),
        );
        mockPubSub.topic = vi.fn().mockImplementation(() => ({
          publishMessage: vi.fn().mockRejectedValue(new Error('topic down')),
        }));
        const orchestrator = createTestOrchestrator();

        await expect(
          orchestrator.ingestPREvent(makeOpenedRequest()),
        ).rejects.toThrow('Review timed out');
      });
    });

    it('passes REVIEW_TIMEOUT_MS through to runReview as timeoutMs', async () => {
      const envWithTimeout = new EnvService(coreEnvSchema, {
        HOST: '0.0.0.0',
        PORT: '8080',
        REVIEW_RESULTS_TOPIC: 'test-review-results-topic',
        GIT_ADAPTER_URL: 'http://adapter:8080',
        LLM_PROVIDER: 'mock',
        REVIEW_MODEL: 'test-model',
        REVIEW_TIMEOUT_MS: '300000',
      });
      mockContextRepo.getContext.mockResolvedValue({
        prKey: 'github:test-org:test-repo:0',
        summary: JSON.stringify({ architecture: 'microservices' }),
        updatedAt: new Date(),
      });
      const orchestrator = createTestOrchestrator({
        envService: envWithTimeout,
      });

      await orchestrator.ingestPREvent(makeOpenedRequest());

      expect(mockRunReview).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ timeoutMs: 300_000 }),
      );
    });

    it('rejects a REVIEW_TIMEOUT_MS above the 540s ack-deadline ceiling', () => {
      expect(
        () =>
          new EnvService(coreEnvSchema, {
            HOST: '0.0.0.0',
            PORT: '8080',
            REVIEW_RESULTS_TOPIC: 'test-review-results-topic',
            GIT_ADAPTER_URL: 'http://adapter:8080',
            LLM_PROVIDER: 'mock',
            REVIEW_MODEL: 'test-model',
            REVIEW_TIMEOUT_MS: '599000',
          }),
      ).toThrow(/Environment validation failed/);
    });
  });
});
