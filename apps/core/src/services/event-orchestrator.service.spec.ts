import { ReviewNotSubmittedError } from '@code-review-agent/agent-code-reviewer';
import { EnvService } from '@code-review-agent/env';
import type {
  GitAdapterContract,
  PREventPayload,
  RepoContext,
} from '@code-review-agent/shared-types';
import { PubSub } from '@google-cloud/pubsub';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { coreEnvSchema, CoreEnvService } from '../env.js';
import { ContextRepository } from '../modules/database/repositories/context.repository.js';
import { LeaseRepository } from '../modules/database/repositories/lease.repository.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import { AgentService } from './agent.service.js';
import {
  ContextBuildInProgressError,
  EventOrchestratorDependencies,
  EventOrchestratorService,
} from './event-orchestrator.service.js';

const SECTIONS = {
  architecture: 'In-process architecture',
  modules: 'core, gateway',
  patterns: 'repositories',
  errorHandling: 'rethrow',
};

const BASELINE: RepoContext = {
  repoKey: 'github:test-org:test-repo',
  sections: { ...SECTIONS, architecture: 'microservices' },
  agentDocs: [{ path: 'AGENTS.md', content: 'Use pnpm.' }],
  updatedAt: new Date('2026-01-01'),
};

function prEvent(
  action: string,
  overrides: Partial<PREventPayload['prMeta']> = {},
  diff = 'diff --git a/file.ts ...',
): PREventPayload {
  return {
    prMeta: {
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 42,
      title: 'Feature X',
      author: 'developer',
      branch: 'feat/x',
      body: 'Details',
      htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
      baseRef: 'develop',
      action,
      isIncrementalUpdate: action === 'closed',
      ...overrides,
    },
    diff,
    changedFiles: diff ? ['file.ts'] : [],
  };
}

describe('EventOrchestratorService', () => {
  let testEnvService: CoreEnvService;
  let publishedMessages: { topic: string; data: Record<string, unknown> }[];
  let mockPubSub: { topic: ReturnType<typeof vi.fn> };
  let mockPrRepo: {
    updatePRStatus: ReturnType<typeof vi.fn>;
    getPRStatus: ReturnType<typeof vi.fn>;
    claimPendingReview: ReturnType<typeof vi.fn>;
  };
  let mockLeaseRepo: {
    tryAcquire: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let mockContextRepo: {
    get: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  let mockAgentService: {
    buildRepoContext: ReturnType<typeof vi.fn>;
    runReview: ReturnType<typeof vi.fn>;
  };

  function createTestOrchestrator(
    overrides: Partial<EventOrchestratorDependencies> = {},
  ): EventOrchestratorService {
    return new EventOrchestratorService({
      envService: testEnvService,
      prRepository: mockPrRepo as unknown as PrRepository,
      contextRepository: mockContextRepo as unknown as ContextRepository,
      leaseRepository: mockLeaseRepo as unknown as LeaseRepository,
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
      CONTEXT_BUILD_TOPIC: 'test-context-builds',
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
      claimPendingReview: vi.fn().mockResolvedValue(true),
    };
    mockLeaseRepo = {
      tryAcquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    mockContextRepo = {
      get: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockAgentService = {
      buildRepoContext: vi.fn().mockResolvedValue({
        sections: SECTIONS,
        agentDocs: [],
        headSha: 'abc123',
      }),
      runReview: vi.fn().mockResolvedValue({
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        summary: 'Automated review passed',
        comments: [{ path: 'src/main.ts', line: 5, body: 'Looks fine' }],
      }),
    };
  });

  const contextBuildMessages = () =>
    publishedMessages.filter((m) => m.topic === 'test-context-builds');

  describe('review actions', () => {
    it('parks the PR and queues a baseline build when the repo has no context', async () => {
      const res = await createTestOrchestrator().ingestPREvent(
        prEvent('opened'),
      );

      expect(res).toMatchObject({ success: true, status: 'queued' });
      expect(mockAgentService.buildRepoContext).not.toHaveBeenCalled();
      expect(mockAgentService.runReview).not.toHaveBeenCalled();
      expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
        'github:test-org:test-repo:42',
        expect.objectContaining({
          status: 'building_context',
          diff: 'diff --git a/file.ts ...',
          prMeta: expect.objectContaining({
            title: 'Feature X',
            baseRef: 'develop',
          }),
        }),
      );
      expect(contextBuildMessages()).toEqual([
        {
          topic: 'test-context-builds',
          data: {
            provider: 'github',
            owner: 'test-org',
            repo: 'test-repo',
            mode: 'baseline',
            ref: 'develop',
            pendingPrNumber: 42,
          },
        },
      ]);
    });

    it('reviews right away with the stored baseline', async () => {
      mockContextRepo.get.mockResolvedValue(BASELINE);

      const res = await createTestOrchestrator().ingestPREvent(
        prEvent('opened'),
      );

      expect(res).toMatchObject({ success: true, status: 'reviewing' });
      expect(contextBuildMessages()).toHaveLength(0);
      expect(mockAgentService.runReview).toHaveBeenCalledWith(
        expect.objectContaining({
          prMeta: expect.objectContaining({
            owner: 'test-org',
            number: 42,
            baseRef: 'develop',
          }),
          context: BASELINE,
        }),
      );
      expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
        'github:test-org:test-repo:42',
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('marks the PR failed, without retrying, when the reviewer submits nothing', async () => {
      mockContextRepo.get.mockResolvedValue(BASELINE);
      mockAgentService.runReview.mockRejectedValue(
        new ReviewNotSubmittedError('github:test-org:test-repo:42'),
      );

      const res = await createTestOrchestrator().ingestPREvent(
        prEvent('opened'),
      );

      expect(res).toMatchObject({ success: false, status: 'failed' });
      expect(publishedMessages).toHaveLength(0);
      expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
        'github:test-org:test-repo:42',
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('fetches diff and changed files from the git adapter when the event has none', async () => {
      mockContextRepo.get.mockResolvedValue(BASELINE);
      const getPRDiff = vi.fn().mockResolvedValue({
        diff: 'fetched-diff-content',
        changedFiles: ['fetched-file.ts'],
      });
      const gitAdapterClient = { getPRDiff } as unknown as GitAdapterContract;

      await createTestOrchestrator({ gitAdapterClient }).ingestPREvent(
        prEvent('opened', {}, ''),
      );

      expect(getPRDiff).toHaveBeenCalledWith('test-org', 'test-repo', 42);
      expect(mockAgentService.runReview).toHaveBeenCalledWith(
        expect.objectContaining({
          diff: 'fetched-diff-content',
          changedFiles: 'fetched-file.ts',
        }),
      );
    });
  });

  describe('merged PRs', () => {
    it('queues an incremental update when the repo has a baseline', async () => {
      mockContextRepo.get.mockResolvedValue(BASELINE);

      const res = await createTestOrchestrator().ingestPREvent(
        prEvent('closed'),
      );

      expect(res).toMatchObject({ success: true, status: 'queued' });
      expect(contextBuildMessages()).toEqual([
        {
          topic: 'test-context-builds',
          data: {
            provider: 'github',
            owner: 'test-org',
            repo: 'test-repo',
            mode: 'incremental',
            prNumber: 42,
          },
        },
      ]);
      expect(mockAgentService.buildRepoContext).not.toHaveBeenCalled();
    });

    it('ignores the merge when the repo has no baseline yet', async () => {
      const res = await createTestOrchestrator().ingestPREvent(
        prEvent('closed'),
      );

      expect(res).toMatchObject({ success: true, status: 'ignored' });
      expect(contextBuildMessages()).toHaveLength(0);
    });
  });

  describe('context build jobs', () => {
    const baselineJob = {
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      mode: 'baseline',
      ref: 'develop',
      pendingPrNumber: 42,
    } as const;
    const incrementalJob = {
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      mode: 'incremental',
      prNumber: 7,
    } as const;

    it('builds the baseline under the repo lease, then reviews the waiting PR', async () => {
      mockPrRepo.getPRStatus.mockResolvedValue({
        status: 'reviewing',
        diff: 'stored-diff',
        changedFiles: ['a.ts'],
        prMeta: {
          title: 'Feature X',
          author: 'dev',
          branch: 'feat/x',
          baseRef: 'develop',
        },
      });

      await createTestOrchestrator().handleContextBuildRequest(baselineJob);

      expect(mockLeaseRepo.tryAcquire).toHaveBeenCalledWith(
        'context-build:github:test-org:test-repo',
        expect.any(String),
        expect.any(Number),
      );
      expect(mockAgentService.buildRepoContext).toHaveBeenCalledWith(
        {
          mode: 'baseline',
          owner: 'test-org',
          repo: 'test-repo',
          ref: 'develop',
        },
        undefined,
      );
      expect(mockContextRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          repoKey: 'github:test-org:test-repo',
          headSha: 'abc123',
        }),
      );
      expect(mockLeaseRepo.release).toHaveBeenCalled();
      expect(mockPrRepo.claimPendingReview).toHaveBeenCalledWith(
        'github:test-org:test-repo:42',
      );
      expect(mockAgentService.runReview).toHaveBeenCalledWith(
        expect.objectContaining({
          diff: 'stored-diff',
          changedFiles: 'a.ts',
          prMeta: expect.objectContaining({ number: 42, title: 'Feature X' }),
          context: expect.objectContaining({ sections: SECTIONS }),
        }),
      );
    });

    it('hands a parked PR back for retry when its review fails transiently', async () => {
      mockContextRepo.get.mockResolvedValue(BASELINE);
      mockAgentService.runReview.mockRejectedValueOnce(new Error('Gemini 503'));
      const orchestrator = createTestOrchestrator();

      await expect(
        orchestrator.handleContextBuildRequest(baselineJob),
      ).rejects.toThrow('Gemini 503');
      expect(mockPrRepo.updatePRStatus).toHaveBeenLastCalledWith(
        'github:test-org:test-repo:42',
        expect.objectContaining({ status: 'building_context' }),
      );

      await orchestrator.handleContextBuildRequest(baselineJob);

      expect(mockPrRepo.claimPendingReview).toHaveBeenCalledTimes(2);
      expect(mockAgentService.runReview).toHaveBeenCalledTimes(2);
      expect(mockPrRepo.updatePRStatus).toHaveBeenLastCalledWith(
        'github:test-org:test-repo:42',
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('throws ContextBuildInProgressError without building when another instance holds the lease', async () => {
      mockLeaseRepo.tryAcquire.mockResolvedValue(false);

      await expect(
        createTestOrchestrator().handleContextBuildRequest(baselineJob),
      ).rejects.toBeInstanceOf(ContextBuildInProgressError);
      expect(mockAgentService.buildRepoContext).not.toHaveBeenCalled();
      expect(mockLeaseRepo.release).not.toHaveBeenCalled();
    });

    it('releases the lease when the build fails', async () => {
      mockAgentService.buildRepoContext.mockRejectedValue(
        new Error('LLM down'),
      );

      await expect(
        createTestOrchestrator().handleContextBuildRequest(baselineJob),
      ).rejects.toThrow('LLM down');
      expect(mockLeaseRepo.release).toHaveBeenCalled();
      expect(mockAgentService.runReview).not.toHaveBeenCalled();
    });

    it('on redelivery reuses the saved baseline and does not review the PR twice', async () => {
      mockContextRepo.get.mockResolvedValue(BASELINE);
      mockPrRepo.claimPendingReview.mockResolvedValue(false);

      await createTestOrchestrator().handleContextBuildRequest(baselineJob);

      expect(mockAgentService.buildRepoContext).not.toHaveBeenCalled();
      expect(mockAgentService.runReview).not.toHaveBeenCalled();
    });

    it('folds a merged PR into the baseline and records it', async () => {
      mockContextRepo.get.mockResolvedValue(BASELINE);

      await createTestOrchestrator().handleContextBuildRequest(incrementalJob);

      expect(mockAgentService.buildRepoContext).toHaveBeenCalledWith(
        {
          mode: 'incremental',
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 7,
          existing: BASELINE,
        },
        undefined,
      );
      expect(mockContextRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sections: SECTIONS, lastAppliedPrNumber: 7 }),
      );
    });

    it('skips a merged PR that was already applied', async () => {
      mockContextRepo.get.mockResolvedValue({
        ...BASELINE,
        lastAppliedPrNumber: 7,
      });

      await createTestOrchestrator().handleContextBuildRequest(incrementalJob);

      expect(mockAgentService.buildRepoContext).not.toHaveBeenCalled();
    });

    it('acknowledges an incremental job whose baseline is gone instead of failing it', async () => {
      await expect(
        createTestOrchestrator().handleContextBuildRequest(incrementalJob),
      ).resolves.toBeUndefined();
      expect(mockAgentService.buildRepoContext).not.toHaveBeenCalled();
    });
  });

  it('publishes review results to REVIEW_RESULTS_TOPIC', async () => {
    await createTestOrchestrator().handleReviewResults({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 42,
      summary: 'Looks great!',
      comments: [{ path: 'src/file.ts', line: 10, body: 'Refactor' }],
    });

    expect(publishedMessages).toEqual([
      {
        topic: 'test-review-results-topic',
        data: expect.objectContaining({
          prNumber: 42,
          summary: 'Looks great!',
        }),
      },
    ]);
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({ status: 'completed' }),
    );
  });
});
