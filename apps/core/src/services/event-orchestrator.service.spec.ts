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
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import { AgentService } from './agent.service.js';
import {
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

  describe('review actions', () => {
    it('builds and saves a baseline from the PR base branch when none exists, then reviews', async () => {
      const res = await createTestOrchestrator().ingestPREvent(
        prEvent('opened'),
      );

      expect(res).toMatchObject({ success: true, status: 'reviewing' });
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
          sections: SECTIONS,
          headSha: 'abc123',
        }),
      );
      expect(mockAgentService.runReview).toHaveBeenCalled();
      expect(publishedMessages).toHaveLength(1);
      expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
        'github:test-org:test-repo:42',
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('reviews with the stored baseline without rebuilding it', async () => {
      mockContextRepo.get.mockResolvedValue(BASELINE);

      await createTestOrchestrator().ingestPREvent(prEvent('opened'));

      expect(mockAgentService.buildRepoContext).not.toHaveBeenCalled();
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
    it('folds the merged PR into the existing baseline', async () => {
      mockContextRepo.get.mockResolvedValue(BASELINE);

      const res = await createTestOrchestrator().ingestPREvent(
        prEvent('closed'),
      );

      expect(res.success).toBe(true);
      expect(mockAgentService.buildRepoContext).toHaveBeenCalledWith(
        {
          mode: 'incremental',
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 42,
          existing: BASELINE,
        },
        undefined,
      );
      expect(mockContextRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          repoKey: 'github:test-org:test-repo',
          sections: SECTIONS,
          lastAppliedPrNumber: 42,
        }),
      );
      expect(mockAgentService.runReview).not.toHaveBeenCalled();
    });

    it('skips the update when the repo has no baseline yet', async () => {
      await createTestOrchestrator().ingestPREvent(prEvent('closed'));

      expect(mockAgentService.buildRepoContext).not.toHaveBeenCalled();
      expect(mockContextRepo.save).not.toHaveBeenCalled();
    });

    it('skips a merged PR that was already applied (Pub/Sub redelivery)', async () => {
      mockContextRepo.get.mockResolvedValue({
        ...BASELINE,
        lastAppliedPrNumber: 42,
      });

      await createTestOrchestrator().ingestPREvent(prEvent('closed'));

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
