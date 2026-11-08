import {
  loadRepoWorkspaceFromTarball,
  type RepoWorkspace,
} from '@code-review-agent/agent-tools';
import {
  type ReviewAgentResult,
  runCodeReview,
} from '@code-review-agent/review-agent';
import {
  type GitAdapterContract,
  NonRetryableTaskError,
  type PREventPayload,
  type PriorFinding,
  type PRMeta,
  type PRState,
  type ReviewResultPayload,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
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
  llm: BaseLlm;
}

const REVIEW_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'review_requested',
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

interface ResolvedDiff {
  rawDiff: string;
  changedFiles?: string[];
}

async function resolveDiff(
  req: PREventPayload,
  client: GitAdapterContract,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ResolvedDiff> {
  if (req.diff) {
    return { rawDiff: req.diff, changedFiles: req.changedFiles };
  }
  const result = await client.getPRDiff(owner, repo, prNumber);
  return { rawDiff: result.diff, changedFiles: result.changedFiles };
}

export class EventOrchestratorService {
  private readonly pubsub: PubSub;
  private readonly prRepository: PrRepository;
  private readonly envService: CoreEnvService;
  private readonly gitAdapterClient: GitAdapterContract;
  private readonly llm: BaseLlm;

  constructor(deps: EventOrchestratorDependencies) {
    this.pubsub = deps.pubsub;
    this.prRepository = deps.prRepository;
    this.envService = deps.envService;
    this.gitAdapterClient = deps.gitAdapterClient;
    this.llm = deps.llm;
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

    return this.processReview(req, meta, prKey);
  }

  async publishReviewResults(payload: ReviewResultPayload): Promise<void> {
    const topicName = this.envService.get('REVIEW_RESULTS_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });
  }

  private async loadWorkspace(
    req: PREventPayload,
    meta: PRMeta,
  ): Promise<RepoWorkspace> {
    const ref = resolveTarballRef(meta);
    const [diffData, tarball] = await Promise.all([
      resolveDiff(
        req,
        this.gitAdapterClient,
        meta.owner,
        meta.repo,
        meta.prNumber,
      ),
      this.gitAdapterClient.getRepoTarball(meta.owner, meta.repo, ref),
    ]);
    return loadRepoWorkspaceFromTarball(tarball, {
      rawDiff: diffData.rawDiff,
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

  private async loadWorkspaceOrHandleError(
    req: PREventPayload,
    meta: PRMeta,
    prKey: string,
  ): Promise<RepoWorkspace> {
    try {
      return await this.loadWorkspace(req, meta);
    } catch (error) {
      if (error instanceof NonRetryableTaskError) {
        return this.handleNonRetryableError(meta, prKey, error);
      }
      throw error;
    }
  }

  private async executeReview(
    meta: PRMeta,
    workspace: RepoWorkspace,
    priorFindings: PriorFinding[],
  ): Promise<ReviewAgentResult> {
    const timeoutMs = this.envService.get('REVIEW_TIMEOUT_MS');
    return runCodeReview(
      { prMeta: meta, workspace, priorFindings },
      { model: this.llm, timeoutMs },
    );
  }

  private async persistReviewResult(
    prKey: string,
    result: ReviewAgentResult,
  ): Promise<PREventResult> {
    const failureReason = result.reviewResult.failure?.reason;
    if (failureReason) {
      await this.prRepository.updatePRStatus(prKey, {
        status: 'failed',
        error: failureReason,
        summary: result.reviewResult.summary,
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
    });
    return {
      success: true,
      status: 'completed',
      message: 'PR review completed',
    };
  }

  private async processReview(
    req: PREventPayload,
    meta: PRMeta,
    prKey: string,
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

    const workspace = await this.loadWorkspaceOrHandleError(req, meta, prKey);
    const result = await this.executeReview(meta, workspace, priorFindings);
    await this.publishReviewResults(result.reviewResult);
    return this.persistReviewResult(prKey, result);
  }
}
