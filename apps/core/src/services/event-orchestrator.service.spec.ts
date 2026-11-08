import { MockLlm } from '@code-review-agent/llm';
import {
  type GitAdapterContract,
  NonRetryableTaskError,
  type PREventPayload,
  type PriorFinding,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { PubSub } from '@google-cloud/pubsub';
import { Header, Pack, ReadEntry } from 'tar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreEnvService } from '../env.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import { EventOrchestratorService } from './event-orchestrator.service.js';

function createTarGzBuffer(
  entries: Array<{ path: string; content: string }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = new Pack({ gzip: true });
    const chunks: Buffer[] = [];
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);

    for (const item of entries) {
      const buf = Buffer.from(item.content, 'utf8');
      const header = new Header({
        path: item.path,
        type: 'File',
        size: buf.length,
        mode: 0o644,
      });
      header.encode();
      const entry = new ReadEntry(header);
      pack.add(entry);
      entry.end(buf);
    }

    pack.end();
  });
}

const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
new file mode 100644
--- /dev/null
+++ b/src/index.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

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
  let mockGitAdapter: {
    getPRDiff: ReturnType<typeof vi.fn>;
    getRepoTarball: ReturnType<typeof vi.fn>;
  };
  let llm: BaseLlm;

  beforeEach(async () => {
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

    const tarGz = await createTarGzBuffer([
      {
        path: 'test-org-test-repo-sha1/src/index.ts',
        content: 'export const a = 1;\nexport const b = 2;\n',
      },
    ]);

    mockGitAdapter = {
      getPRDiff: vi.fn().mockResolvedValue({
        diff: sampleDiff,
        changedFiles: ['src/index.ts'],
      }),
      getRepoTarball: vi.fn().mockResolvedValue(
        new Response(new Uint8Array(tarGz), {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
        }),
      ),
    };

    const mockEnvService = {
      get: vi.fn((key: string) => {
        if (key === 'REVIEW_RESULTS_TOPIC') return 'review-results-topic';
        if (key === 'REVIEW_TIMEOUT_MS') return 30_000;
        return undefined;
      }),
    } as unknown as CoreEnvService;

    llm = new MockLlm({ defaultResponse: 'Code looks great!' });

    service = new EventOrchestratorService({
      envService: mockEnvService,
      prRepository: mockPrRepo as unknown as PrRepository,
      pubsub: mockPubSub as unknown as PubSub,
      gitAdapterClient: mockGitAdapter as unknown as GitAdapterContract,
      llm,
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

  it('executes full end-to-end review when PR event is reviewable', async () => {
    const res = await service.ingestPREvent({
      prMeta: {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        title: 'Test PR',
        author: 'octocat',
        branch: 'feat',
        headSha: 'sha1',
        htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
        action: 'opened',
      },
    });

    expect(res).toEqual({
      success: true,
      status: 'completed',
      message: 'PR review completed',
    });
    expect(mockGitAdapter.getPRDiff).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
    );

    // Marked reviewing initially
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({
        status: 'reviewing',
      }),
    );

    // Published review results
    expect(mockPublishMessage).toHaveBeenCalledWith({
      json: expect.objectContaining({
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        summary: 'Code looks great!',
      }),
    });

    // Marked completed with summary and publishedFindings
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({
        status: 'completed',
        summary: 'Code looks great!',
        publishedFindings: [],
      }),
    );
  });

  it('performs incremental review passing prior findings from prRepository', async () => {
    const prior: PriorFinding = {
      path: 'src/index.ts',
      startLine: 1,
      endLine: 1,
      severity: 'minor',
      title: 'Previous issue',
    };
    mockPrRepo.getPRStatus.mockResolvedValue({
      provider: 'github',
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 42,
      status: 'completed',
      updatedAt: new Date(),
      publishedFindings: [prior],
    });

    const res = await service.ingestPREvent({
      prMeta: {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        title: 'Incremental PR update',
        author: 'octocat',
        branch: 'feat',
        headSha: 'sha1',
        htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
        action: 'synchronize',
      },
    });

    expect(res.status).toBe('completed');
    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({
        status: 'completed',
        publishedFindings: [prior],
      }),
    );
  });

  it('handles agent review failure when submit_review is not called', async () => {
    const failingLlm = new MockLlm({
      generateResponse: () => 'I refuse to call tools',
    });
    const failingService = new EventOrchestratorService({
      envService: {
        get: vi.fn(() => 30_000),
      } as unknown as CoreEnvService,
      prRepository: mockPrRepo as unknown as PrRepository,
      pubsub: mockPubSub as unknown as PubSub,
      gitAdapterClient: mockGitAdapter as unknown as GitAdapterContract,
      llm: failingLlm,
    });

    const res = await failingService.ingestPREvent({
      prMeta: {
        provider: 'github',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        title: 'Test PR',
        author: 'octocat',
        branch: 'feat',
        headSha: 'sha1',
        htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
        action: 'opened',
      },
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe('error');
    expect(res.message).toContain('submit_review');

    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('submit_review'),
      }),
    );
    expect(mockPublishMessage).toHaveBeenCalledWith({
      json: expect.objectContaining({
        failure: expect.objectContaining({
          reason: expect.stringContaining('submit_review'),
        }),
      }),
    });
  });

  it('handles NonRetryableTaskError during tarball loading by recording failure and rethrowing', async () => {
    mockGitAdapter.getRepoTarball.mockRejectedValue(
      new NonRetryableTaskError('Tarball not found'),
    );

    await expect(
      service.ingestPREvent({
        prMeta: {
          provider: 'github',
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 42,
          title: 'Test PR',
          author: 'octocat',
          branch: 'feat',
          headSha: 'sha1',
          htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
          action: 'opened',
        },
      }),
    ).rejects.toThrow(NonRetryableTaskError);

    expect(mockPrRepo.updatePRStatus).toHaveBeenCalledWith(
      'github:test-org:test-repo:42',
      expect.objectContaining({
        status: 'failed',
        error: 'Tarball not found',
      }),
    );
    expect(mockPublishMessage).toHaveBeenCalledWith({
      json: expect.objectContaining({
        failure: { reason: 'Tarball not found' },
      }),
    });
  });

  it('rethrows transient error during tarball loading without marking PR as failed', async () => {
    mockGitAdapter.getRepoTarball.mockRejectedValue(
      new Error('Temporary network connection reset'),
    );

    await expect(
      service.ingestPREvent({
        prMeta: {
          provider: 'github',
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 42,
          title: 'Test PR',
          author: 'octocat',
          branch: 'feat',
          headSha: 'sha1',
          htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
          action: 'opened',
        },
      }),
    ).rejects.toThrow('Temporary network connection reset');

    expect(mockPrRepo.updatePRStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'failed',
      }),
    );
    expect(mockPublishMessage).not.toHaveBeenCalled();
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
