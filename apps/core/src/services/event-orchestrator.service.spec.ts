import {
  GitAdapterContract,
  PREventPayload,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { PubSub } from '@google-cloud/pubsub';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreEnvService } from '../env.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import { EventOrchestratorService } from './event-orchestrator.service.js';

describe('EventOrchestratorService', () => {
  let service: EventOrchestratorService;
  let mockPrRepo: {
    updatePRStatus: ReturnType<typeof vi.fn>;
    getPRStatus: ReturnType<typeof vi.fn>;
    deletePRStatus: ReturnType<typeof vi.fn>;
  };
  let mockPublishMessage: ReturnType<typeof vi.fn>;
  let mockPubSub: {
    topic: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockPrRepo = {
      updatePRStatus: vi.fn().mockResolvedValue(undefined),
      getPRStatus: vi.fn().mockResolvedValue(null),
      deletePRStatus: vi.fn().mockResolvedValue(undefined),
    };
    mockPublishMessage = vi.fn().mockResolvedValue('msg-1');
    mockPubSub = {
      topic: vi.fn().mockReturnValue({
        publishMessage: mockPublishMessage,
      }),
    };

    const mockEnvService = {
      get: vi.fn((key: string) => {
        if (key === 'REVIEW_RESULTS_TOPIC') return 'review-results-topic';
        return undefined;
      }),
    } as unknown as CoreEnvService;

    service = new EventOrchestratorService({
      envService: mockEnvService,
      prRepository: mockPrRepo as unknown as PrRepository,
      pubsub: mockPubSub as unknown as PubSub,
      gitAdapterClient: {} as GitAdapterContract,
      llm: {} as BaseLlm,
    });
  });

  it('returns error when prMeta is missing', async () => {
    const res = await service.ingestPREvent({} as PREventPayload);
    expect(res).toEqual({
      success: false,
      status: 'error',
      message: 'Missing PR metadata',
    });
  });

  it('ignores non-reviewable actions', async () => {
    const res = await service.ingestPREvent({
      prMeta: {
        provider: 'github',
        owner: 'usermeme',
        repo: 'test-repo',
        prNumber: 1,
        title: 'Test',
        author: 'octocat',
        branch: 'feat',
        htmlUrl: 'https://github.com/usermeme/test-repo/pull/1',
        action: 'closed',
      },
    });

    expect(res).toEqual({
      success: true,
      status: 'ignored',
      message: 'Ignored action: closed',
    });
    expect(mockPrRepo.updatePRStatus).not.toHaveBeenCalled();
  });

  it('queues reviewable PR actions and updates PR status', async () => {
    const res = await service.ingestPREvent({
      prMeta: {
        provider: 'github',
        owner: 'usermeme',
        repo: 'test-repo',
        prNumber: 42,
        title: 'Test PR',
        author: 'octocat',
        branch: 'feat',
        htmlUrl: 'https://github.com/usermeme/test-repo/pull/42',
        action: 'opened',
      },
    });

    expect(res).toEqual({
      success: true,
      status: 'queued',
      message: 'PR event queued',
    });
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:usermeme:test-repo:42',
      expect.objectContaining({
        provider: 'github',
        owner: 'usermeme',
        repo: 'test-repo',
        prNumber: 42,
        status: 'queued',
      }),
    );
  });

  it('publishes review results to configured topic', async () => {
    await service.publishReviewResults({
      provider: 'github',
      owner: 'usermeme',
      repo: 'test-repo',
      prNumber: 42,
      comments: [],
      summary: 'LGTM',
    });

    expect(mockPubSub.topic).toHaveBeenCalledWith('review-results-topic');
    expect(mockPublishMessage).toHaveBeenCalledWith({
      json: {
        provider: 'github',
        owner: 'usermeme',
        repo: 'test-repo',
        prNumber: 42,
        comments: [],
        summary: 'LGTM',
      },
    });
  });
});
