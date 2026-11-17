import {
  buildReviewContext,
  type BuildReviewContextResult,
  CONTEXT_SOURCE_BASENAMES,
  type ContextSourceRef,
  hashContextSources,
  type LoadedContextSource,
  type ResolvedReviewContext,
  REVIEW_CONTEXT_BUILDER_VERSION,
  selectContextSources,
} from '@code-review-agent/review-agent';
import type {
  DiscardedContextSource,
  GitAdapterContract,
  PRMeta,
  ReviewContextDoc,
  TokenUsage,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import type { FastifyBaseLogger } from 'fastify';

import {
  reviewContextId,
  ReviewContextRepository,
} from '../modules/database/repositories/review-context.repository.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A ready context is dropped by the Firestore TTL policy after this. */
const READY_TTL_MS = 90 * DAY_MS;
/** A failed build is not retried for this long; reviews use the fallback. */
const FAILED_RETRY_AFTER_MS = 15 * 60 * 1000;
/** Below this budget a build is not attempted (and no failure is stored). */
const MIN_BUILD_TIMEOUT_MS = 5_000;
/** Most source files fetched for one build. */
const MAX_SOURCE_FILES = 150;
const BLOB_FETCH_CONCURRENCY = 8;

export interface ReviewContextServiceDependencies {
  gitAdapterClient: GitAdapterContract;
  repository: ReviewContextRepository;
  /** Model the builder runs on (the triage model in production). */
  model: BaseLlm;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface BuildTarget {
  meta: PRMeta;
  id: string;
  sourceHash: string;
  refs: ContextSourceRef[];
}

function fallback(
  reason: string,
  sourceHash?: string,
  usage?: TokenUsage,
): ResolvedReviewContext {
  return {
    rules: null,
    metrics: {
      origin: 'fallback',
      ruleCount: 0,
      fallbackReason: reason,
      ...(sourceHash ? { sourceHash } : {}),
    },
    ...(usage ? { usage } : {}),
  };
}

function fromStored(doc: ReviewContextDoc): ResolvedReviewContext {
  return {
    rules: doc.rules,
    metrics: {
      origin: 'cache',
      sourceHash: doc.sourceHash,
      ruleCount: doc.rules.length,
    },
  };
}

function isRetryDue(doc: ReviewContextDoc, nowMs: number): boolean {
  return nowMs >= (doc.retryAfterMs ?? 0);
}

function recentFailure(
  doc: ReviewContextDoc,
  sourceHash: string,
): ResolvedReviewContext {
  const error = doc.error ?? 'unknown error';
  return fallback(`The last context build failed: ${error}`, sourceHash);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapInBatches<Item, Result>(
  items: Item[],
  batchSize: number,
  map: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    results.push(...(await Promise.all(batch.map(map))));
  }
  return results;
}

/**
 * Resolves the review rules for a PR from the guideline and skill files on
 * its BASE branch, so a PR cannot change the rules it is reviewed against.
 * Contexts are stored by source hash: a cache hit costs one tree listing.
 * Fails open: any error yields the raw-guidelines fallback.
 */
export class ReviewContextService {
  private readonly gitAdapterClient: GitAdapterContract;
  private readonly repository: ReviewContextRepository;
  private readonly model: BaseLlm;
  private readonly now: () => number;

  constructor(deps: ReviewContextServiceDependencies) {
    this.gitAdapterClient = deps.gitAdapterClient;
    this.repository = deps.repository;
    this.model = deps.model;
    this.now = deps.now ?? Date.now;
  }

  async resolve(
    meta: PRMeta,
    timeoutMs: number,
    logger?: FastifyBaseLogger,
  ): Promise<ResolvedReviewContext> {
    try {
      return await this.resolveFromBase(meta, timeoutMs, logger);
    } catch (error) {
      logger?.warn(
        { err: error },
        '[Core] Could not resolve the review context; using raw guidelines',
      );
      return fallback(describeError(error));
    }
  }

  private async resolveFromBase(
    meta: PRMeta,
    timeoutMs: number,
    logger?: FastifyBaseLogger,
  ): Promise<ResolvedReviewContext> {
    if (!meta.baseRef) return fallback('The PR has no base branch.');
    const listing = await this.gitAdapterClient.listTreeFiles(
      meta.owner,
      meta.repo,
      meta.baseRef,
      CONTEXT_SOURCE_BASENAMES,
    );
    if (listing.truncated) {
      return fallback('The base branch tree is too large to list.');
    }
    const refs = selectContextSources(listing.files);
    if (refs.length === 0) {
      return { rules: [], metrics: { origin: 'empty', ruleCount: 0 } };
    }
    const sourceHash = hashContextSources(refs);
    const target = {
      meta,
      id: reviewContextId(meta, sourceHash),
      sourceHash,
      refs,
    };
    return this.resolveTarget(target, timeoutMs, logger);
  }

  private async resolveTarget(
    target: BuildTarget,
    timeoutMs: number,
    logger?: FastifyBaseLogger,
  ): Promise<ResolvedReviewContext> {
    const stored = await this.repository.get(target.id);
    const outcome = this.storedOutcome(stored, target.sourceHash);
    if (outcome) return outcome;
    if (timeoutMs < MIN_BUILD_TIMEOUT_MS) {
      return fallback('No time left to build the context.', target.sourceHash);
    }
    return this.build(target, timeoutMs, logger);
  }

  /** A ready context, a recent failure, or null when a build is due. */
  private storedOutcome(
    stored: ReviewContextDoc | null,
    sourceHash: string,
  ): ResolvedReviewContext | null {
    if (!stored) return null;
    if (stored.status === 'ready') return fromStored(stored);
    if (isRetryDue(stored, this.now())) return null;
    return recentFailure(stored, sourceHash);
  }

  private async build(
    target: BuildTarget,
    timeoutMs: number,
    logger?: FastifyBaseLogger,
  ): Promise<ResolvedReviewContext> {
    const fetched = target.refs.slice(0, MAX_SOURCE_FILES);
    const skipped = target.refs.slice(MAX_SOURCE_FILES).map((ref) => ({
      path: ref.path,
      reason: 'Over the source file limit.',
    }));
    const sources = await this.loadSources(target.meta, fetched);
    const result = await buildReviewContext(this.model, { sources }, timeoutMs);
    await this.store(target, result, skipped, logger);
    if (!result.ok) {
      return fallback(
        `Context build failed: ${result.error}`,
        target.sourceHash,
        result.usage,
      );
    }
    logger?.info(
      `[Core] Built review context ${target.id}: ${result.rules.length} rules from ${result.sources.length} sources`,
    );
    return {
      rules: result.rules,
      metrics: {
        origin: 'built',
        sourceHash: target.sourceHash,
        ruleCount: result.rules.length,
      },
      usage: result.usage,
    };
  }

  private async loadSources(
    meta: PRMeta,
    refs: ContextSourceRef[],
  ): Promise<LoadedContextSource[]> {
    return mapInBatches(refs, BLOB_FETCH_CONCURRENCY, async (ref) => ({
      ...ref,
      content: await this.gitAdapterClient.getBlob(
        meta.owner,
        meta.repo,
        ref.blobSha,
      ),
    }));
  }

  /** A failed write only costs a rebuild next time; the review goes on. */
  private async store(
    target: BuildTarget,
    result: BuildReviewContextResult,
    skipped: DiscardedContextSource[],
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    try {
      await this.repository.put(target.id, this.toDoc(target, result, skipped));
    } catch (error) {
      logger?.warn({ err: error }, '[Core] Could not store the review context');
    }
  }

  private toDoc(
    target: BuildTarget,
    result: BuildReviewContextResult,
    skipped: DiscardedContextSource[],
  ): ReviewContextDoc {
    const builtAtMs = this.now();
    const base = {
      provider: target.meta.provider,
      owner: target.meta.owner,
      repo: target.meta.repo,
      sourceHash: target.sourceHash,
      builderVersion: REVIEW_CONTEXT_BUILDER_VERSION,
      sources: result.sources,
      discarded: [...result.discarded, ...skipped],
      model: this.model.model,
      usage: result.usage,
      builtAt: new Date(builtAtMs),
    };
    if (result.ok) {
      return {
        ...base,
        status: 'ready',
        rules: result.rules,
        expireAt: new Date(builtAtMs + READY_TTL_MS),
      };
    }
    const retryAfterMs = builtAtMs + FAILED_RETRY_AFTER_MS;
    return {
      ...base,
      status: 'failed',
      rules: [],
      error: result.error,
      retryAfterMs,
      expireAt: new Date(retryAfterMs + DAY_MS),
    };
  }
}
