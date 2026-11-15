import {
  loadRepoWorkspaceFromTarball,
  RepoWorkspace,
} from '@code-review-agent/agent-tools';
import type { AgentModels } from '@code-review-agent/llm';
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  type ReviewAgentResult,
  type ReviewPipelineResult,
  runReviewPipeline,
} from '@code-review-agent/review-agent';
import {
  type GitAdapterContract,
  NonRetryableTaskError,
  type PRDiffResult,
  type PREventPayload,
  type PriorFinding,
  type PRMeta,
  type PRState,
  type ReviewMetrics,
  type ReviewResultPayload,
  type ReviewThread,
} from '@code-review-agent/shared-types';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';

import type { CoreEnvService } from '../env.js';
import { PrRepository } from '../modules/database/repositories/pr.repository.js';

export interface PREventResult {
  success: boolean;
  status: 'queued' | 'reviewing' | 'completed' | 'ignored' | 'error';
  message: string;
}

export interface EventOrchestratorDependencies {
  envService: CoreEnvService;
  prRepository: PrRepository;
  pubsub: PubSub;
  gitAdapterClient: GitAdapterContract;
  models: AgentModels;
}

const REVIEW_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'review_requested',
  'ready_for_review',
  'manual_trigger',
]);

function isReviewableAction(action: string): boolean {
  return REVIEW_ACTIONS.has(action);
}

function extractPriorFindings(state: PRState | null): PriorFinding[] {
  if (!state || !state.publishedFindings) {
    return [];
  }
  return state.publishedFindings;
}

function resolveTarballRef(meta: PRMeta): string {
  return meta.headSha || meta.branch;
}

export class EventOrchestratorService {
  private readonly pubsub: PubSub;
  private readonly prRepository: PrRepository;
  private readonly envService: CoreEnvService;
  private readonly gitAdapterClient: GitAdapterContract;
  private readonly models: AgentModels;

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub;
    this.prRepository = deps.prRepository;
    this.envService = deps.envService;
    this.gitAdapterClient = deps.gitAdapterClient;
    this.models = deps.models;
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

    if (logger) {
      logger.info(`[Core] Ingesting PR event: ${action} for ${prKey}`);
    }

    if (!isReviewableAction(action)) {
      return {
        success: true,
        status: 'ignored',
        message: `Ignored action: ${action}`,
      };
    }

    return this.processReview(meta, prKey, logger);
  }

  async publishReviewResults(payload: ReviewResultPayload): Promise<void> {
    const topicName = this.envService.get('REVIEW_RESULTS_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });
  }

  private async fetchDiff(meta: PRMeta): Promise<PRDiffResult> {
    return this.gitAdapterClient.getPRDiff(
      meta.owner,
      meta.repo,
      meta.prNumber,
    );
  }

  /**
   * Existing review threads only sharpen dedup; a failure to read them
   * (e.g. missing GraphQL permission) must not block the review.
   */
  private async fetchThreads(
    meta: PRMeta,
    logger?: FastifyBaseLogger,
  ): Promise<ReviewThread[]> {
    try {
      return await this.gitAdapterClient.getReviewThreads(
        meta.owner,
        meta.repo,
        meta.prNumber,
      );
    } catch (error) {
      logger?.warn(
        { err: error },
        '[Core] Could not read review threads; continuing without them',
      );
      return [];
    }
  }

  private async loadWorkspace(
    meta: PRMeta,
    diffData: PRDiffResult,
  ): Promise<RepoWorkspace> {
    const tarball = await this.gitAdapterClient.getRepoTarball(
      meta.owner,
      meta.repo,
      resolveTarballRef(meta),
    );
    return loadRepoWorkspaceFromTarball(tarball, {
      rawDiff: diffData.diff,
      changedFiles: diffData.changedFiles,
    });
  }

  private async handleNonRetryableError(
    meta: PRMeta,
    prKey: string,
    error: NonRetryableTaskError,
  ): Promise<never> {
    const summary = `Review failed: ${error.message}`;
    await this.prRepository.updatePRStatus(prKey, {
      status: 'failed',
      error: error.message,
      summary,
    });
    await this.publishReviewResults({
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      comments: [],
      summary,
      failure: { reason: error.message },
    });
    throw error;
  }

  /** Runs a git-adapter call; a non-retryable failure is published to the PR. */
  private async callAdapter<T>(
    meta: PRMeta,
    prKey: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof NonRetryableTaskError) {
        return this.handleNonRetryableError(meta, prKey, error);
      }
      throw error;
    }
  }

  private async executeReview(
    meta: PRMeta,
    prKey: string,
    priorFindings: PriorFinding[],
    logger?: FastifyBaseLogger,
  ): Promise<ReviewPipelineResult> {
    const [diffData, reviewThreads] = await Promise.all([
      this.callAdapter(meta, prKey, () => this.fetchDiff(meta)),
      this.fetchThreads(meta, logger),
    ]);
    const diffWorkspace = new RepoWorkspace({
      files: new Map(),
      rawDiff: diffData.diff,
      changedFiles: diffData.changedFiles,
    });
    return runReviewPipeline(
      {
        prMeta: meta,
        diffWorkspace,
        loadWorkspace: () =>
          this.callAdapter(meta, prKey, () =>
            this.loadWorkspace(meta, diffData),
          ),
        priorFindings,
        reviewThreads,
      },
      {
        models: this.models,
        timeoutMs:
          this.envService.get('REVIEW_TIMEOUT_MS') ?? DEFAULT_REVIEW_TIMEOUT_MS,
        deepReviewPaths: this.envService.get('DEEP_REVIEW_PATHS'),
      },
    );
  }

  private async persistSkip(
    prKey: string,
    metrics: ReviewMetrics,
  ): Promise<PREventResult> {
    await this.prRepository.updatePRStatus(prKey, {
      status: 'skipped',
      summary: metrics.route.reason,
      lastReview: metrics,
    });
    return {
      success: true,
      status: 'ignored',
      message: `Review skipped: ${metrics.route.reason}`,
    };
  }

  private async persistReviewResult(
    prKey: string,
    result: ReviewAgentResult,
    metrics: ReviewMetrics,
  ): Promise<PREventResult> {
    const failureReason = result.reviewResult.failure?.reason;
    if (failureReason) {
      await this.prRepository.updatePRStatus(prKey, {
        status: 'failed',
        error: failureReason,
        summary: result.reviewResult.summary,
        lastReview: metrics,
      });
      return {
        success: false,
        status: 'error',
        message: failureReason,
      };
    }

    await this.prRepository.updatePRStatus(prKey, {
      status: 'completed',
      summary: result.reviewResult.summary,
      publishedFindings: result.publishedFindings,
      lastReview: metrics,
    });
    return {
      success: true,
      status: 'completed',
      message: 'PR review completed',
    };
  }

  private async processReview(
    meta: PRMeta,
    prKey: string,
    logger?: FastifyBaseLogger,
  ): Promise<PREventResult> {
    const existing = await this.prRepository.getPRStatus(prKey);
    const priorFindings = extractPriorFindings(existing);

    await this.prRepository.updatePRStatus(prKey, {
      provider: meta.provider,
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      status: 'reviewing',
    });

    const { publish, metrics } = await this.executeReview(
      meta,
      prKey,
      priorFindings,
      logger,
    );
    logger?.info(
      { route: metrics.route, usage: metrics.usage },
      `[Core] Review route for ${prKey}: ${metrics.route.tier} (${metrics.route.source})`,
    );
    if (!publish) {
      return this.persistSkip(prKey, metrics);
    }
    await this.publishReviewResults(publish.reviewResult);
    return this.persistReviewResult(prKey, publish, metrics);
  }
}
