import { randomUUID } from 'node:crypto';

import {
  isDuplicateFinding,
  isPriorDuplicate,
  parseBaselineSections,
  prepareDiff,
  priorFindingSchema,
  type ReviewExecutionInput,
  type RunReviewOptions,
} from '@code-review-agent/agent-code-reviewer';
import type {
  BuildContextOptions,
  ContextLoader,
} from '@code-review-agent/agent-context-builder';
import {
  GitAdapterContract,
  NonRetryableTaskError,
  PREventPayload,
  type PriorFinding,
  PRMeta,
  PRState,
  type ReviewCommentPayload,
  ReviewResultPayload,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';

import type { CoreEnvService } from '../env.js';
import { BaselineLockRepository } from '../modules/database/repositories/baseline-lock.repository.js';
import { ContextRepository } from '../modules/database/repositories/context.repository.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';
import type { AgentService } from './agent.service.js';

/** Poll interval and total wait while another instance holds the baseline lock. */
const BASELINE_LOCK_POLL_MS = 5_000;
const BASELINE_LOCK_WAIT_MS = 20 * 60 * 1000;

/**
 * Upper bound on findings accumulated across review runs for one PR. The list
 * is injected into reviewer prompts on every run and stored on the PR doc, so
 * it must not grow without bound on long-lived PRs; oldest entries are evicted.
 */
const MAX_STORED_PUBLISHED_FINDINGS = 200;

interface BaselineBuildParams {
  baselineKey: string;
  prKey: string;
  meta: PRMeta;
  diff: string;
  changedFiles?: string[];
  logger?: FastifyBaseLogger;
}

/** PR metadata as persisted alongside a PR record. */
type StoredPrMeta = NonNullable<PRState['prMeta']>;

/** Outcome of waiting for another instance's baseline build. */
interface BaselineSlotOutcome {
  summary?: string;
  acquired: boolean;
}

export interface PREventResult {
  success: boolean;
  status: 'queued' | 'reviewing' | 'ignored' | 'error';
  message: string;
}

export interface EventOrchestratorDependencies {
  envService: CoreEnvService;
  prRepository: PrRepository;
  contextRepository: ContextRepository;
  /** Optional cross-instance lock for baseline builds (Firestore-backed). */
  baselineLockRepository?: BaselineLockRepository;
  pubsub: PubSub;
  agentService: AgentService;
  gitAdapterClient: GitAdapterContract;
  llm: BaseLlm;
  /** Optional cheaper model for context-build chunk summarization. */
  summaryLlm?: BaseLlm;
}

/** PR actions that trigger a review (as opposed to merge bookkeeping/ignore). */
const REVIEW_ACTIONS = [
  'opened',
  'synchronize',
  'reopened',
  'review_requested',
  'manual_trigger',
];

function isReviewableAction(action: string): boolean {
  return REVIEW_ACTIONS.includes(action);
}

/** True when the event is a PR merge that should refresh the baseline. */
function isMergedPrEvent(meta: PRMeta): boolean {
  return meta.action === 'closed' && Boolean(meta.isIncrementalUpdate);
}

/** Normalizes the buildContext result into the summary string we persist. */
function toSummaryString(sections: Record<string, string> | string): string {
  return typeof sections === 'string' ? sections : JSON.stringify(sections);
}

/** Renders a changed-file list into the newline-joined string reviews consume. */
function toChangedFilesString(changedFiles: string[] | undefined): string {
  return changedFiles?.join('\n') ?? '';
}

/** The event-carried diff/files, defaulted the way the review path expects. */
function readRequestedChanges(req: PREventPayload): {
  diff: string;
  changedFiles: string[];
} {
  return { diff: req.diff || '', changedFiles: req.changedFiles || [] };
}

/** True when the event carried no usable diff, so the adapter must supply it. */
function needsDiffFetch(diff: string, changedFiles: string[]): boolean {
  return !diff || changedFiles.length === 0;
}

/** First truthy of event value, stored value, and fallback. */
function backfillField(
  value: string | undefined,
  stored: string | undefined,
  fallback: string,
): string {
  return value || stored || fallback;
}

/** Fills gaps in the event metadata from the stored PR record; event wins. */
function mergeStoredPrMeta(meta: PRMeta, storedMeta: StoredPrMeta): PRMeta {
  return {
    ...meta,
    title: backfillField(meta.title, storedMeta['title'], ''),
    author: backfillField(meta.author, storedMeta['author'], ''),
    branch: backfillField(meta.branch, storedMeta['branch'], ''),
    body: backfillField(meta.body, storedMeta['body'], ''),
    baseRef: backfillField(meta.baseRef, storedMeta['baseRef'], 'main'),
    headSha: meta.headSha || storedMeta['headSha'],
  };
}

/** True when the event already carries the metadata `/review` comments omit. */
function hasCompletePrMeta(meta: PRMeta): boolean {
  return Boolean(meta.branch && meta.title && meta.author);
}

/**
 * Drops malformed stored findings instead of failing the whole review: the
 * records come from a mutable datastore, and one poisoned row must not make
 * every future review of that PR deterministically unparseable.
 */
function sanitizePriorFindings(
  findings: PriorFinding[] | undefined,
): PriorFinding[] {
  return (findings ?? []).filter(
    (f) => priorFindingSchema.safeParse(f).success,
  );
}

function extractStoredPRInfo(
  meta: PRMeta,
  storedPR: PRState | null,
): { resolvedMeta: PRMeta; priorFindings: PriorFinding[] } {
  // Backfill only incomplete event metadata (e.g. `/review` issue_comment
  // webhooks). Merging on complete events would resurrect fields the author
  // deliberately cleared (an emptied PR body) from the stored record.
  const resolvedMeta =
    storedPR?.prMeta && !hasCompletePrMeta(meta)
      ? mergeStoredPrMeta(meta, storedPR.prMeta)
      : meta;
  return {
    resolvedMeta,
    priorFindings: sanitizePriorFindings(storedPR?.publishedFindings),
  };
}

const COMMENT_HEADER_REGEX =
  /^###\s*\[(CRITICAL|MAJOR|MINOR)\]\s*(.+?)(?:\n|$)/i;

function extractPublishedFinding(
  comment: ReviewCommentPayload,
): PriorFinding | null {
  const match = COMMENT_HEADER_REGEX.exec(comment.body);
  if (!match) return null;
  const severity = match[1].toLowerCase() as 'critical' | 'major' | 'minor';
  const title = match[2].trim();
  const endLine = comment.position ?? comment.line ?? 1;
  const startLine = comment.startPosition ?? endLine;
  return {
    path: comment.path,
    startLine,
    endLine,
    severity,
    title,
  };
}

function extractPublishedFindings(
  comments: ReviewCommentPayload[],
): PriorFinding[] {
  const findings: PriorFinding[] = [];
  for (const comment of comments) {
    const finding = extractPublishedFinding(comment);
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
}

/** Review input for an in-process review of the event's own PR metadata. */
function buildReviewInput(
  meta: PRMeta,
  diff: string,
  changedFiles: string[] | undefined,
  priorFindings: PriorFinding[] = [],
): ReviewExecutionInput {
  return {
    prMeta: {
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      number: meta.prNumber,
      title: meta.title,
      author: meta.author,
      branch: meta.branch,
      body: meta.body,
      baseRef: meta.baseRef,
      headSha: meta.headSha,
    },
    diff,
    changedFiles: toChangedFilesString(changedFiles),
    priorFindings,
  };
}

/** Firestore rejects `undefined` values, so stored text fields get defaults. */
function storedText(value: string | undefined): string {
  return value ?? '';
}

/** headSha is stored only when known. */
function storedHeadSha(meta: PRMeta): { headSha?: string } {
  return meta.headSha ? { headSha: meta.headSha } : {};
}

/** The prMeta payload for a PR status row. Every field must be defined —
 * Firestore rejects `undefined` values — and headSha is stored only when known. */
function buildStoredPrMeta(meta: PRMeta) {
  return {
    title: storedText(meta.title),
    author: storedText(meta.author),
    branch: storedText(meta.branch),
    body: storedText(meta.body),
    baseRef: meta.baseRef ?? 'main',
    ...storedHeadSha(meta),
  };
}

/**
 * Appends this run's published comments to the stored finding history.
 * Cross-run comparison ignores lines (commits shift them); findings from THIS
 * batch share one diff, so they get the strict line-aware dedup — two distinct
 * same-title findings in one run must not collapse into a single history entry.
 */
function mergeNewIntoStoredFindings(
  stored: PriorFinding[],
  comments: ReviewCommentPayload[],
): PriorFinding[] {
  const merged: PriorFinding[] = [...stored];
  const fromThisRun: PriorFinding[] = [];
  for (const candidate of extractPublishedFindings(comments)) {
    const knownFromHistory = stored.some((prior) =>
      isPriorDuplicate(candidate, prior),
    );
    const knownFromRun = fromThisRun.some((finding) =>
      isDuplicateFinding(candidate, finding),
    );
    if (!knownFromHistory && !knownFromRun) {
      fromThisRun.push(candidate);
      merged.push(candidate);
    }
  }
  return merged;
}

export class EventOrchestratorService {
  private pubsub: PubSub;
  private prRepository: PrRepository;
  private contextRepository: ContextRepository;
  private baselineLockRepository?: BaselineLockRepository;
  private envService: CoreEnvService;
  private agentService: AgentService;
  private gitAdapterClient: GitAdapterContract;
  private llm: BaseLlm;
  private summaryLlm?: BaseLlm;
  /** Unique per-process id, used as the baseline-lock owner. */
  private readonly lockOwner = randomUUID();
  /**
   * In-process dedup for baseline builds: concurrent PR events (or Pub/Sub
   * push retries) for the same repo must not trigger two full tarball
   * downloads + summarization runs. Cross-instance dedup is handled by the
   * optional Firestore-backed baselineLockRepository.
   */
  private readonly baselineBuilds = new Map<string, Promise<string>>();

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub;
    this.prRepository = deps.prRepository;
    this.contextRepository = deps.contextRepository;
    this.baselineLockRepository = deps.baselineLockRepository;
    this.envService = deps.envService;
    this.agentService = deps.agentService;
    this.gitAdapterClient = deps.gitAdapterClient;
    this.llm = deps.llm;
    this.summaryLlm = deps.summaryLlm;
  }

  /** Guards against saving/using an "empty" context payload (cache poisoning). */
  private isValidSummary(
    summary: string | null | undefined,
  ): summary is string {
    const trimmed = summary?.trim();
    return !!trimmed && trimmed !== '{}' && trimmed !== '{"summary":""}';
  }

  /** Loads a persisted baseline context and parses it into named sections. */
  private createContextLoader(): ContextLoader {
    return async (key: string) => {
      const stored = await this.contextRepository.getContext(key);
      if (!stored?.summary) return null;
      const sections = parseBaselineSections(stored.summary);
      return Object.keys(sections).length > 0 ? sections : null;
    };
  }

  async ingestPREvent(
    req: PREventPayload,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
    const meta = req.prMeta;
    if (!meta) {
      return {
        success: false,
        status: 'error',
        message: 'Missing PR metadata',
      };
    }

    const { provider, owner, repo, prNumber, action } = meta;
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;
    const baselineKey = `${provider}:${owner}:${repo}:0`;

    logger?.info(`[Core] Ingesting PR event: ${action} for ${prKey}`);

    // If PR is merged, trigger incremental context update in-process
    if (isMergedPrEvent(meta)) {
      return this.buildIncrementalBaselineContext(
        meta,
        prKey,
        baselineKey,
        logger,
      );
    }

    if (isReviewableAction(action)) {
      return this.reviewPullRequest(req, meta, prKey, baselineKey, logger);
    }

    return {
      success: true,
      status: 'ignored',
      message: `Ignored action: ${action}`,
    };
  }

  /** Runs the incremental baseline refresh triggered by a merged PR event. */
  private async buildIncrementalBaselineContext(
    meta: PRMeta,
    prKey: string,
    baselineKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
    logger?.info(
      `[Core] PR merged event for ${prKey}. Triggering incremental context build.`,
    );
    const sections = await this.agentService.buildContext({
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      cloneUrl: meta.cloneUrl,
      ref: meta.baseRef,
      isIncrementalUpdate: true,
      llm: this.llm,
      summaryLlm: this.summaryLlm,
      contextLoader: this.createContextLoader(),
      gitAdapter: this.gitAdapterClient,
    });

    const summary = toSummaryString(sections);
    await this.saveBaselineSummaryIfValid(baselineKey, summary, logger);
    await this.prRepository.deletePRStatus(prKey);

    return {
      success: true,
      status: 'queued',
      message: 'Incremental context build completed for merged PR',
    };
  }

  private async loadStoredPRInfo(
    meta: PRMeta,
    prKey: string,
  ): Promise<{ resolvedMeta: PRMeta; priorFindings: PriorFinding[] }> {
    const storedPR = await this.prRepository
      .getPRStatus(prKey)
      .catch(() => null);
    return extractStoredPRInfo(meta, storedPR);
  }

  private async ensureDiffAndFiles(
    req: PREventPayload,
    meta: PRMeta,
    prKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<{ diff: string; changedFiles: string[] }> {
    let { diff, changedFiles } = readRequestedChanges(req);
    if (needsDiffFetch(diff, changedFiles)) {
      ({ diff, changedFiles } = await this.fetchDiffFromAdapter(
        { diff, changedFiles },
        meta.owner,
        meta.repo,
        meta.prNumber,
        prKey,
        logger,
      ));
    }
    return {
      diff: prepareDiff(diff).diff,
      changedFiles,
    };
  }

  /**
   * Review path for `opened`/`synchronize`/`reopened`/`review_requested`/
   * `manual_trigger` events: resolve metadata, ensure diff + baseline
   * context, then run the review in-process and publish its results.
   */
  private async reviewPullRequest(
    req: PREventPayload,
    meta: PRMeta,
    prKey: string,
    baselineKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
    const { resolvedMeta, priorFindings } = await this.loadStoredPRInfo(
      meta,
      prKey,
    );
    const { diff, changedFiles } = await this.ensureDiffAndFiles(
      req,
      resolvedMeta,
      prKey,
      logger,
    );

    const buildParams: BaselineBuildParams = {
      baselineKey,
      prKey,
      meta: resolvedMeta,
      diff,
      changedFiles,
      logger,
    };

    const baselineSummary = await this.resolveBaselineSummary(buildParams);
    await this.recordPrBuildStatus(buildParams, 'reviewing');

    const reviewResult = await this.runReviewOrFail(
      prKey,
      buildReviewInput(resolvedMeta, diff, changedFiles, priorFindings),
      this.createRunReviewOptions(baselineSummary),
    );

    await this.handleReviewResults(reviewResult, prKey, logger);

    return {
      success: true,
      status: 'reviewing',
      message: 'Review completed and results published',
    };
  }

  /**
   * Fetches diff + changed files from the git adapter, falling back to the
   * values the event carried when the adapter call fails.
   */
  private async fetchDiffFromAdapter(
    fallback: { diff: string; changedFiles: string[] },
    owner: string,
    repo: string,
    prNumber: number,
    prKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<{ diff: string; changedFiles: string[] }> {
    try {
      logger?.info(
        `[Core] Fetching diff and changed files from git adapter for ${prKey}`,
      );
      const adapterData = await this.gitAdapterClient.getPRDiff(
        owner,
        repo,
        prNumber,
      );
      return { diff: adapterData.diff, changedFiles: adapterData.changedFiles };
    } catch (err) {
      if (err instanceof NonRetryableTaskError) {
        await this.prRepository
          .updatePRStatus(prKey, { status: 'failed', error: err.message })
          .catch(() => {
            // status bookkeeping must not mask the original failure
          });
        throw err;
      }
      logger?.warn(
        `[Core] Failed to fetch PR diff from adapter for ${prKey}: ${String(err)}`,
      );
      return fallback;
    }
  }

  /** Returns the stored baseline summary when valid, else builds + saves one. */
  private async resolveBaselineSummary(
    params: BaselineBuildParams,
  ): Promise<string> {
    // Check if baseline context exists in Firestore
    const existingContext = await this.contextRepository.getContext(
      params.baselineKey,
    );

    const storedSummary = existingContext?.summary;
    if (this.isValidSummary(storedSummary)) {
      return storedSummary;
    }
    return this.buildAndSaveBaselineContext(params);
  }

  /** Persists the PR row while a baseline build/review is in progress. */
  private async recordPrBuildStatus(
    params: BaselineBuildParams,
    status: 'queued' | 'reviewing',
  ): Promise<void> {
    const { meta } = params;
    await this.prRepository.updatePRStatus(params.prKey, {
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      status,
      diff: params.diff,
      changedFiles: params.changedFiles,
      prMeta: buildStoredPrMeta(meta),
    });
  }

  private createRunReviewOptions(baselineContext: string): RunReviewOptions {
    return {
      llm: this.llm,
      baselineContext,
      gitAdapter: this.gitAdapterClient,
    };
  }

  /**
   * Runs the review; on failure marks the PR as failed and rethrows so the
   * failure is visible (Pub/Sub nack / 500) instead of silently publishing a
   * misleading "no findings" review.
   */
  private async runReviewOrFail(
    prKey: string,
    input: ReviewExecutionInput,
    options: RunReviewOptions,
  ): Promise<ReviewResultPayload> {
    try {
      return await this.agentService.runReview(input, options);
    } catch (error) {
      await this.prRepository
        .updatePRStatus(prKey, { status: 'failed', error: String(error) })
        .catch(() => {
          // status bookkeeping must not mask the original failure
        });
      throw error;
    }
  }

  private async assertMatchingCoordinates(
    prKey: string,
    expectedPrKey: string,
  ): Promise<void> {
    if (prKey === expectedPrKey) return;
    const error = `Review result coordinates (${prKey}) do not match the originating PR event (${expectedPrKey}); refusing to publish.`;
    await this.prRepository
      .updatePRStatus(expectedPrKey, { status: 'failed', error })
      .catch(() => {
        // status bookkeeping must not mask the original failure
      });
    throw new NonRetryableTaskError(error);
  }

  /**
   * Merges this run's published comments into the PR's stored finding
   * history. Returns `null` when the stored record could not be read: the
   * caller must then OMIT `publishedFindings` from the status write so the
   * Firestore merge preserves the existing history — writing a list seeded
   * from a failed read would wipe it.
   */
  private async mergeStoredAndNewFindings(
    prKey: string,
    comments: ReviewCommentPayload[],
    logger?: FastifyBaseLogger,
  ): Promise<PriorFinding[] | null> {
    let storedPR: PRState | null;
    try {
      storedPR = await this.prRepository.getPRStatus(prKey);
    } catch (error) {
      logger?.warn(
        `[Core] Could not read stored findings for ${prKey}; keeping existing history untouched: ${String(error)}`,
      );
      return null;
    }
    const stored = sanitizePriorFindings(storedPR?.publishedFindings);
    const merged = mergeNewIntoStoredFindings(stored, comments);
    return merged.slice(-MAX_STORED_PUBLISHED_FINDINGS);
  }

  async handleReviewResults(
    payload: ReviewResultPayload,
    expectedPrKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    const { provider, owner, repo, prNumber, summary } = payload;
    const prKey = `${provider}:${owner}:${repo}:${prNumber}`;
    await this.assertMatchingCoordinates(prKey, expectedPrKey);

    logger?.info(
      `[Core] Handling review results for ${prKey}. Publishing to Review Results topic.`,
    );

    try {
      await this.publishReviewResults(payload);
      const publishedFindings = await this.mergeStoredAndNewFindings(
        prKey,
        payload.comments,
        logger,
      );
      await this.prRepository
        .updatePRStatus(prKey, {
          status: 'completed',
          summary,
          // Omitted (not []) when the stored history could not be read, so
          // the field-level merge preserves whatever is already in Firestore.
          ...(publishedFindings ? { publishedFindings } : {}),
        })
        .catch((error) => {
          // The review is already published; failing the delivery here would
          // redeliver the PR event and post a duplicate review to the PR.
          logger?.warn(
            `[Core] Could not record completion for ${prKey}: ${String(error)}`,
          );
        });
    } catch (error) {
      logger?.error(
        `[Core] Failed to publish review results: ${String(error)}`,
      );
      await this.prRepository.updatePRStatus(prKey, {
        status: 'failed',
        error: String(error),
      });
      throw error;
    }
  }

  private buildAndSaveBaselineContext(
    params: BaselineBuildParams,
  ): Promise<string> {
    // Dedup concurrent baseline builds for the same repository (e.g. an
    // 'opened' + 'review_requested' pair, or a Pub/Sub push retry after a
    // timeout): reuse the in-flight build instead of paying for a second
    // tarball download + full summarization run.
    const inFlight = this.baselineBuilds.get(params.baselineKey);
    if (inFlight !== undefined) {
      params.logger?.info(
        `[Core] Baseline build for ${params.baselineKey} already in flight; awaiting it.`,
      );
      return inFlight;
    }

    const build = this.doBuildAndSaveBaselineContext(params).finally(() => {
      this.baselineBuilds.delete(params.baselineKey);
    });
    this.baselineBuilds.set(params.baselineKey, build);
    return build;
  }

  /**
   * Cross-instance dedup wrapper: acquires the Firestore baseline lock (when
   * configured) so a burst of PR events across Cloud Run instances pays for
   * the expensive tarball + summarization build only once. Waiters reuse the
   * winner's stored context; on lock timeout we build anyway (correctness
   * over dedup).
   */
  private async doBuildAndSaveBaselineContext(
    params: BaselineBuildParams,
  ): Promise<string> {
    const lock = this.baselineLockRepository;
    if (!lock) {
      return this.buildBaselineNow(params);
    }

    let acquired = await lock.tryAcquire(params.baselineKey, this.lockOwner);
    if (!acquired) {
      const outcome = await this.awaitLockedBaselineContext(params, lock);
      if (outcome.summary !== undefined) {
        return outcome.summary;
      }
      acquired = outcome.acquired;
    }

    try {
      return await this.buildBaselineNow(params);
    } finally {
      if (acquired) {
        await lock.release(params.baselineKey, this.lockOwner);
      }
    }
  }

  /**
   * Announces the lock wait, then blocks on the other instance's build.
   * Returns its stored summary when the context appears while waiting,
   * otherwise whether this instance took over the lock.
   */
  private async awaitLockedBaselineContext(
    params: BaselineBuildParams,
    lock: BaselineLockRepository,
  ): Promise<BaselineSlotOutcome> {
    params.logger?.info(
      `[Core] Baseline build for ${params.baselineKey} is locked by another instance; waiting for its context.`,
    );
    const outcome = await this.awaitBaselineSlot(params.baselineKey, lock);
    this.logBaselineWaitOutcome(params, outcome);
    return outcome;
  }

  private logBaselineWaitOutcome(
    params: BaselineBuildParams,
    outcome: BaselineSlotOutcome,
  ): void {
    if (outcome.summary !== undefined) {
      params.logger?.info(
        `[Core] Baseline context for ${params.baselineKey} became available while waiting; reusing it.`,
      );
      return;
    }
    if (!outcome.acquired) {
      params.logger?.warn(
        `[Core] Timed out waiting for the baseline lock on ${params.baselineKey}; building anyway.`,
      );
    }
  }

  /**
   * Waits for another instance's baseline build. Resolves with the stored
   * summary once it appears, `{ acquired: true }` when this instance took over
   * the (expired) lock, or `{ acquired: false }` after the wait budget.
   */
  private async awaitBaselineSlot(
    baselineKey: string,
    lock: BaselineLockRepository,
  ): Promise<BaselineSlotOutcome> {
    const deadline = Date.now() + BASELINE_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, BASELINE_LOCK_POLL_MS),
      );
      const stored = await this.contextRepository.getContext(baselineKey);
      const storedSummary = stored?.summary;
      if (this.isValidSummary(storedSummary)) {
        return { summary: storedSummary, acquired: false };
      }
      if (await lock.tryAcquire(baselineKey, this.lockOwner)) {
        return { acquired: true };
      }
    }
    return { acquired: false };
  }

  private async buildBaselineNow(params: BaselineBuildParams): Promise<string> {
    params.logger?.info(
      `[Core] No baseline context found for ${params.baselineKey}. Building context in-process.`,
    );
    await this.recordPrBuildStatus(params, 'queued');

    let sections: Record<string, string> | string;
    try {
      sections = await this.agentService.buildContext(
        this.buildBaselineContextRequest(params),
      );
    } catch (error) {
      await this.prRepository
        .updatePRStatus(params.prKey, {
          status: 'failed',
          error: String(error),
        })
        .catch(() => {
          // status bookkeeping must not mask the original failure
        });
      throw error;
    }

    const summary = toSummaryString(sections);
    await this.saveBaselineSummaryIfValid(
      params.baselineKey,
      summary,
      params.logger,
    );
    return summary;
  }

  /** Context-build request for a full (non-incremental) baseline build. */
  private buildBaselineContextRequest(
    params: BaselineBuildParams,
  ): BuildContextOptions {
    const { meta } = params;
    return {
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      cloneUrl:
        meta.cloneUrl || `https://github.com/${meta.owner}/${meta.repo}.git`,
      ref: meta.baseRef || 'main',
      isIncrementalUpdate: false,
      llm: this.llm,
      summaryLlm: this.summaryLlm,
      contextLoader: this.createContextLoader(),
      gitAdapter: this.gitAdapterClient,
    };
  }

  /** Saves the built summary unless it is "empty" (cache-poisoning guard). */
  private async saveBaselineSummaryIfValid(
    baselineKey: string,
    summary: string,
    logger?: FastifyBaseLogger,
  ): Promise<void> {
    if (this.isValidSummary(summary)) {
      await this.contextRepository.saveContext(baselineKey, { summary });
    } else {
      logger?.warn(
        `[Core] Baseline context generation returned empty for ${baselineKey}. Skipping save to prevent cache poisoning.`,
      );
    }
  }

  private async publishReviewResults(
    payload: ReviewResultPayload,
  ): Promise<void> {
    const topicName = this.envService.get('REVIEW_RESULTS_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });
  }
}
