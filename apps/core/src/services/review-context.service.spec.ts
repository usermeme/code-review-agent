import { MockLlm } from '@code-review-agent/llm';
import { REVIEW_CONTEXT_BUILDER_VERSION } from '@code-review-agent/review-agent';
import type {
  GitAdapterContract,
  PRMeta,
  RepoTreeFile,
  ReviewContextDoc,
} from '@code-review-agent/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewContextRepository } from '../modules/database/repositories/review-context.repository.js';
import { InMemoryDatabaseService } from '../modules/database/testing/in-memory-database.service.js';
import { ReviewContextService } from './review-context.service.js';

const META: PRMeta = {
  provider: 'github',
  owner: 'acme',
  repo: 'payments',
  prNumber: 7,
  title: 'feat: charge',
  author: 'alice',
  branch: 'feat/charge',
  htmlUrl: 'https://github.com/acme/payments/pull/7',
  action: 'opened',
  baseRef: 'main',
};

const AGENTS_MD = '# Rules\nRun pnpm nx test.\nNever log card numbers.';

const RULES_RESPONSE = {
  rules: [
    {
      id: 'no-card-logging',
      rule: 'Never log card numbers.',
      appliesTo: [],
      severity: 'critical',
      source: { path: 'AGENTS.md', startLine: 3, endLine: 3 },
    },
  ],
};

const TIMEOUT_MS = 30_000;

interface FakeAdapter {
  listTreeFiles: ReturnType<typeof vi.fn>;
  getBlob: ReturnType<typeof vi.fn>;
}

function fakeAdapter(
  files: RepoTreeFile[],
  blobs: Record<string, string>,
): FakeAdapter {
  return {
    listTreeFiles: vi.fn(async () => ({ files, truncated: false })),
    getBlob: vi.fn(async (_owner: string, _repo: string, sha: string) => {
      const content = blobs[sha];
      if (content === undefined) throw new Error(`no blob ${sha}`);
      return content;
    }),
  };
}

function builderSays(response: unknown): MockLlm {
  return new MockLlm({
    model: 'mock-builder',
    generateResponse: () =>
      typeof response === 'string'
        ? response
        : (response as Record<string, unknown>),
  });
}

describe('ReviewContextService', () => {
  let db: InMemoryDatabaseService;
  let repository: ReviewContextRepository;
  let adapter: FakeAdapter;
  let nowMs: number;

  function service(model: MockLlm): ReviewContextService {
    return new ReviewContextService({
      gitAdapterClient: adapter as unknown as GitAdapterContract,
      repository,
      model,
      now: () => nowMs,
    });
  }

  function storedDocs(): ReviewContextDoc[] {
    const docs = db.collections.get('review_contexts')?.values() ?? [];
    return [...docs] as unknown as ReviewContextDoc[];
  }

  beforeEach(() => {
    db = new InMemoryDatabaseService();
    repository = new ReviewContextRepository(db);
    nowMs = Date.UTC(2026, 10, 17);
    adapter = fakeAdapter(
      [
        { path: 'AGENTS.md', blobSha: 'blob-agents' },
        { path: 'src/index.ts', blobSha: 'blob-src' },
      ],
      { 'blob-agents': AGENTS_MD },
    );
  });

  it('builds the context from the base branch and stores it', async () => {
    const model = builderSays(RULES_RESPONSE);

    const resolved = await service(model).resolve(META, TIMEOUT_MS);

    expect(adapter.listTreeFiles).toHaveBeenCalledWith(
      'acme',
      'payments',
      'main',
      expect.arrayContaining(['agents.md', 'skill.md']),
    );
    expect(adapter.getBlob).toHaveBeenCalledTimes(1);
    expect(resolved.rules?.map((rule) => rule.id)).toEqual(['no-card-logging']);
    expect(resolved.metrics).toMatchObject({ origin: 'built', ruleCount: 1 });

    const [doc] = storedDocs();
    expect(doc).toMatchObject({
      provider: 'github',
      owner: 'acme',
      repo: 'payments',
      status: 'ready',
      builderVersion: REVIEW_CONTEXT_BUILDER_VERSION,
      model: 'mock-builder',
      sources: [
        {
          path: 'AGENTS.md',
          kind: 'guideline',
          blobSha: 'blob-agents',
          chars: AGENTS_MD.length,
        },
      ],
      discarded: [],
    });
    expect(doc.sourceHash).toBe(resolved.metrics.sourceHash);
    expect(doc.expireAt.getTime()).toBe(nowMs + 90 * 24 * 60 * 60 * 1000);
  });

  it('serves a stored context without fetching files or calling the model', async () => {
    await service(builderSays(RULES_RESPONSE)).resolve(META, TIMEOUT_MS);
    adapter.getBlob.mockClear();
    const model = builderSays(RULES_RESPONSE);

    const resolved = await service(model).resolve(META, TIMEOUT_MS);

    expect(resolved.metrics.origin).toBe('cache');
    expect(resolved.rules).toHaveLength(1);
    expect(adapter.getBlob).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
  });

  it('rebuilds when a source file changes on the base branch', async () => {
    await service(builderSays(RULES_RESPONSE)).resolve(META, TIMEOUT_MS);
    adapter = fakeAdapter([{ path: 'AGENTS.md', blobSha: 'blob-v2' }], {
      'blob-v2': 'Never log card numbers or CVVs.',
    });

    const resolved = await service(builderSays(RULES_RESPONSE)).resolve(
      META,
      TIMEOUT_MS,
    );

    expect(resolved.metrics.origin).toBe('built');
    expect(storedDocs()).toHaveLength(2);
  });

  it('returns no rules and calls nothing when the base branch has no sources', async () => {
    adapter = fakeAdapter([{ path: 'src/index.ts', blobSha: 'x' }], {});
    const model = builderSays(RULES_RESPONSE);

    const resolved = await service(model).resolve(META, TIMEOUT_MS);

    expect(resolved).toEqual({
      rules: [],
      metrics: { origin: 'empty', ruleCount: 0 },
    });
    expect(model.calls).toHaveLength(0);
    expect(storedDocs()).toHaveLength(0);
  });

  it('stores a failed build and falls back until the retry time', async () => {
    const resolved = await service(builderSays('not json')).resolve(
      META,
      TIMEOUT_MS,
    );

    expect(resolved.rules).toBeNull();
    expect(resolved.metrics.origin).toBe('fallback');
    expect(resolved.metrics.fallbackReason).toContain('Context build failed');
    expect(resolved.usage).toBeDefined();
    const [failed] = storedDocs();
    expect(failed).toMatchObject({ status: 'failed', rules: [] });
    expect(failed.retryAfterMs).toBe(nowMs + 15 * 60 * 1000);

    const retryTooSoon = builderSays(RULES_RESPONSE);
    const blocked = await service(retryTooSoon).resolve(META, TIMEOUT_MS);
    expect(blocked.metrics.fallbackReason).toContain(
      'The last context build failed',
    );
    expect(retryTooSoon.calls).toHaveLength(0);
  });

  it('rebuilds after the retry time and drops the failure fields', async () => {
    await service(builderSays('not json')).resolve(META, TIMEOUT_MS);
    nowMs += 16 * 60 * 1000;

    const resolved = await service(builderSays(RULES_RESPONSE)).resolve(
      META,
      TIMEOUT_MS,
    );

    expect(resolved.metrics.origin).toBe('built');
    const [doc] = storedDocs();
    expect(doc.status).toBe('ready');
    expect(doc).not.toHaveProperty('error');
    expect(doc).not.toHaveProperty('retryAfterMs');
  });

  it('does not build, or store a failure, without enough time', async () => {
    const model = builderSays(RULES_RESPONSE);

    const resolved = await service(model).resolve(META, 1_000);

    expect(resolved.metrics.fallbackReason).toBe(
      'No time left to build the context.',
    );
    expect(model.calls).toHaveLength(0);
    expect(storedDocs()).toHaveLength(0);
  });

  it('falls back when the PR has no base branch', async () => {
    const resolved = await service(builderSays(RULES_RESPONSE)).resolve(
      { ...META, baseRef: undefined },
      TIMEOUT_MS,
    );

    expect(resolved.metrics.fallbackReason).toBe('The PR has no base branch.');
    expect(adapter.listTreeFiles).not.toHaveBeenCalled();
  });

  it('falls back when the base tree listing is truncated', async () => {
    adapter.listTreeFiles.mockResolvedValue({ files: [], truncated: true });

    const resolved = await service(builderSays(RULES_RESPONSE)).resolve(
      META,
      TIMEOUT_MS,
    );

    expect(resolved.metrics.fallbackReason).toBe(
      'The base branch tree is too large to list.',
    );
  });

  it('falls back when the adapter fails', async () => {
    adapter.listTreeFiles.mockRejectedValue(new Error('adapter down'));

    const resolved = await service(builderSays(RULES_RESPONSE)).resolve(
      META,
      TIMEOUT_MS,
    );

    expect(resolved).toEqual({
      rules: null,
      metrics: {
        origin: 'fallback',
        ruleCount: 0,
        fallbackReason: 'adapter down',
      },
    });
  });

  it('still returns the built rules when storing them fails', async () => {
    vi.spyOn(repository, 'put').mockRejectedValue(new Error('firestore down'));

    const resolved = await service(builderSays(RULES_RESPONSE)).resolve(
      META,
      TIMEOUT_MS,
    );

    expect(resolved.metrics.origin).toBe('built');
    expect(resolved.rules).toHaveLength(1);
  });
});
