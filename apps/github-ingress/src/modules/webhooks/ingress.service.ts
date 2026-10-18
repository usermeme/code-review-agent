import { PREventPayload, PRMeta } from '@code-review-agent/shared-types';
import { PubSub } from '@google-cloud/pubsub';
import { Webhooks } from '@octokit/webhooks';
import { FastifyBaseLogger } from 'fastify';

import type { IngressEnvService } from '../../env.js';
import {
  GithubWebhookPayload,
  ProcessedWebhookResult,
} from './interfaces/webhooks.interface.js';

type PullRequestPayload = NonNullable<GithubWebhookPayload['pull_request']>;
type PrBasePayload = NonNullable<PullRequestPayload['base']>;
type RepositoryPayload = NonNullable<GithubWebhookPayload['repository']>;
type IssuePayload = NonNullable<GithubWebhookPayload['issue']>;
type MergedPrPayload = GithubWebhookPayload & {
  pull_request: PullRequestPayload;
};
type PrCommentPayload = GithubWebhookPayload & { issue: IssuePayload };

interface PrEventRef {
  owner: string;
  repo: string;
  prNumber: number;
}

const TRACKED_PR_ACTIONS = [
  'opened',
  'synchronize',
  'reopened',
  'review_requested',
];

function buildFallbackCloneUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

function readRepositoryRef(payload: GithubWebhookPayload): {
  owner: string;
  repo: string;
} {
  const repository: Partial<RepositoryPayload> = payload.repository ?? {};
  return {
    owner: repository.owner?.login || '',
    repo: repository.name || '',
  };
}

function readPrEventRef(payload: GithubWebhookPayload): PrEventRef {
  const pullRequest: Partial<PullRequestPayload> = payload.pull_request ?? {};
  const { owner, repo } = readRepositoryRef(payload);
  return { owner, repo, prNumber: pullRequest.number || 0 };
}

function hasCompletePrRef(ref: PrEventRef): boolean {
  return Boolean(ref.owner && ref.repo && ref.prNumber);
}

function isMergedCloseEvent(
  payload: GithubWebhookPayload,
  action: string,
): payload is MergedPrPayload {
  return action === 'closed' && Boolean(payload.pull_request?.merged);
}

function isTrackedPrAction(action: string): boolean {
  return TRACKED_PR_ACTIONS.includes(action);
}

function readPrDescription(pullRequest: Partial<PullRequestPayload>) {
  const user: Partial<PullRequestPayload['user']> = pullRequest.user ?? {};
  return {
    title: pullRequest.title || '',
    author: user.login || '',
    body: pullRequest.body || '',
  };
}

function readPrHeadRefs(pullRequest: Partial<PullRequestPayload>) {
  const head: Partial<PullRequestPayload['head']> = pullRequest.head ?? {};
  return {
    branch: head.ref || '',
    headSha: head.sha || '',
  };
}

function readPrBaseRefs(
  pullRequest: Partial<PullRequestPayload>,
  owner: string,
  repo: string,
) {
  const base: Partial<PrBasePayload> = pullRequest.base ?? {};
  const baseRepo: Partial<NonNullable<PrBasePayload['repo']>> = base.repo ?? {};
  return {
    cloneUrl: baseRepo.clone_url || buildFallbackCloneUrl(owner, repo),
    baseRef: base.ref || 'main',
  };
}

function buildPrMeta(
  pullRequest: Partial<PullRequestPayload>,
  ref: PrEventRef,
  action: string,
  isIncrementalUpdate: boolean,
): PRMeta {
  return {
    provider: 'github',
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.prNumber,
    ...readPrDescription(pullRequest),
    ...readPrHeadRefs(pullRequest),
    htmlUrl: pullRequest.html_url || '',
    action,
    ...readPrBaseRefs(pullRequest, ref.owner, ref.repo),
    isIncrementalUpdate,
  };
}

function isPrCommentCreated(
  payload: GithubWebhookPayload,
): payload is PrCommentPayload {
  return payload.action === 'created' && Boolean(payload.issue?.pull_request);
}

function hasReviewTrigger(payload: GithubWebhookPayload): boolean {
  const commentBody = payload.comment?.body || '';
  return commentBody.includes('/review');
}

function readIssueDescription(issue: IssuePayload) {
  const user: Partial<NonNullable<IssuePayload['user']>> = issue.user ?? {};
  return {
    title: issue.title || '',
    author: user.login || '',
    body: issue.body || '',
  };
}

function buildManualTriggerPrMeta(payload: PrCommentPayload): PRMeta {
  const { owner, repo } = readRepositoryRef(payload);
  const repository: Partial<RepositoryPayload> = payload.repository ?? {};
  return {
    provider: 'github',
    owner,
    repo,
    prNumber: payload.issue.number,
    ...readIssueDescription(payload.issue),
    branch: '',
    htmlUrl: payload.issue.html_url,
    action: 'manual_trigger',
    cloneUrl: repository.clone_url || buildFallbackCloneUrl(owner, repo),
    baseRef: 'main',
    isIncrementalUpdate: false,
  };
}

export interface GithubIngressServiceDependencies {
  envService: IngressEnvService;
  pubsub: PubSub;
  webhooks: Webhooks;
}

export class GithubIngressService {
  private webhooks: Webhooks;
  private pubsub: PubSub;
  private envService: IngressEnvService;

  constructor(deps: GithubIngressServiceDependencies) {
    this.envService = deps.envService;
    this.pubsub = deps.pubsub;
    this.webhooks = deps.webhooks;
  }

  private async publishPREvent(payload: PREventPayload): Promise<void> {
    const topicName = this.envService.get('PR_EVENTS_TOPIC');
    await this.pubsub.topic(topicName).publishMessage({
      json: payload,
    });
  }

  async verifySignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<boolean> {
    const signature = headers['x-hub-signature-256'];
    if (!signature || typeof signature !== 'string') {
      return false;
    }

    return this.webhooks.verify(rawBody, signature);
  }

  async processWebhook(
    headers: Record<string, string | string[] | undefined>,
    payload: unknown,
    logger: FastifyBaseLogger,
  ): Promise<ProcessedWebhookResult> {
    const event = headers['x-github-event'] as string;
    const ghPayload = payload as GithubWebhookPayload;

    switch (event) {
      case 'pull_request':
        return this.processPullRequestEvent(ghPayload, logger);
      case 'issue_comment':
        return this.processIssueCommentEvent(ghPayload, logger);
      default:
        return { ignored: true, reason: 'Ignored GitHub event' };
    }
  }

  private async processPullRequestEvent(
    payload: GithubWebhookPayload,
    logger: FastifyBaseLogger,
  ): Promise<ProcessedWebhookResult> {
    const action = payload.action || '';
    const ref = readPrEventRef(payload);

    if (!hasCompletePrRef(ref)) {
      return { ignored: true, reason: 'Missing PR owner, repo or number' };
    }

    if (isMergedCloseEvent(payload, action)) {
      return this.publishMergedPrEvent(payload, ref, logger);
    }

    if (isTrackedPrAction(action)) {
      return this.publishTrackedPrEvent(payload, ref, action, logger);
    }

    return { ignored: true, reason: `Ignored PR action: ${action}` };
  }

  private async publishMergedPrEvent(
    payload: MergedPrPayload,
    ref: PrEventRef,
    logger: FastifyBaseLogger,
  ): Promise<ProcessedWebhookResult> {
    logger.info(
      `Received GitHub PR merged event: ${payload.pull_request.html_url}`,
    );

    const eventPayload: PREventPayload = {
      prMeta: buildPrMeta(payload.pull_request, ref, 'closed', true),
      diff: '',
      changedFiles: [],
    };

    await this.publishPREvent(eventPayload);
    return { ignored: false, reason: 'PR merged event published to queue' };
  }

  private async publishTrackedPrEvent(
    payload: GithubWebhookPayload,
    ref: PrEventRef,
    action: string,
    logger: FastifyBaseLogger,
  ): Promise<ProcessedWebhookResult> {
    logger.info(
      `Received GitHub PR event: ${action} for ${payload.pull_request?.html_url}`,
    );

    const pullRequest: Partial<PullRequestPayload> = payload.pull_request ?? {};
    const eventPayload: PREventPayload = {
      prMeta: buildPrMeta(pullRequest, ref, action, false),
      diff: '',
      changedFiles: [],
    };

    await this.publishPREvent(eventPayload);
    return { ignored: false, reason: 'PR event published to queue' };
  }

  private async processIssueCommentEvent(
    payload: GithubWebhookPayload,
    logger: FastifyBaseLogger,
  ): Promise<ProcessedWebhookResult> {
    if (!isPrCommentCreated(payload) || !hasReviewTrigger(payload)) {
      return { ignored: true, reason: 'Ignored issue comment action' };
    }

    logger.info(
      `Received GitHub manual /review trigger on ${payload.issue.html_url}`,
    );

    const eventPayload: PREventPayload = {
      prMeta: buildManualTriggerPrMeta(payload),
      diff: '',
      changedFiles: [],
    };

    await this.publishPREvent(eventPayload);
    return {
      ignored: false,
      reason: 'Manual review event published to queue',
    };
  }
}
