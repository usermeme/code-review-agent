import { Webhooks } from '@octokit/webhooks';
import { Octokit } from '@octokit/rest';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';
import { getSecret } from '../../../services/secrets.service.js';
import { GitAdapter } from '../interfaces/git-adapter.interface.js';
import { ProcessedWebhookResult } from '../../webhooks/interfaces/webhooks.interface.js';
import { WebhookEventPayload } from 'shared-types';
import { PrRepository } from '../../database/repositories/pr.repository.js';
import { ContextRepository } from '../../database/repositories/context.repository.js';

export interface GithubWebhookPayload {
  action?: string;
  pull_request?: {
    number: number;
    html_url: string;
    title: string;
    body: string;
    user: { login: string };
    head: { ref: string };
  };
  issue?: {
    number: number;
    html_url: string;
    pull_request?: unknown;
  };
  comment?: {
    body: string;
  };
  repository?: {
    name: string;
    owner?: {
      login: string;
    };
  };
}

export interface GithubAdapterDependencies {
  pubsub?: PubSub;
  octokit?: Octokit;
}

export class GithubAdapter implements GitAdapter {
  private webhooks?: Webhooks;
  private octokit?: Octokit;
  private pubsub?: PubSub;

  constructor(
    private prRepository: PrRepository,
    private contextRepository: ContextRepository,
    deps: GithubAdapterDependencies = {},
  ) {
    if (deps.pubsub) {
      this.pubsub = deps.pubsub;
    }
    if (deps.octokit) {
      this.octokit = deps.octokit;
    }
  }

  async init(logger: FastifyBaseLogger): Promise<void> {
    let githubSecret = process.env.GIT_ADAPTER_WEBHOOK_SECRET || 'dummy-secret-for-local-dev';
    let githubToken = process.env.GIT_ADAPTER_TOKEN || 'dummy-token-for-local-dev';

    if (githubSecret.startsWith('projects/')) {
      try {
        githubSecret = await getSecret(githubSecret);
      } catch (e) {
        logger.error(`Failed to fetch github secret: ${e}`);
      }
    }

    if (githubToken.startsWith('projects/')) {
      try {
        githubToken = await getSecret(githubToken);
      } catch (e) {
        logger.error(`Failed to fetch github token: ${e}`);
      }
    }

    this.webhooks = new Webhooks({ secret: githubSecret });
    if (!this.octokit) {
      this.octokit = new Octokit({ auth: githubToken });
    }
    if (!this.pubsub) {
      this.pubsub = new PubSub();
    }
  }

  private get octokitClient(): Octokit {
    if (!this.octokit) {
      throw new Error('GithubAdapter not initialized: octokit is missing');
    }
    return this.octokit;
  }

  private get pubsubClient(): PubSub {
    if (!this.pubsub) {
      throw new Error('GithubAdapter not initialized: pubsub is missing');
    }
    return this.pubsub;
  }

  canHandle(headers: Record<string, string | string[] | undefined>): boolean {
    return headers['x-github-event'] !== undefined;
  }

  async verifySignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<boolean> {
    if (!this.webhooks) {
      throw new Error('GithubAdapter not initialized');
    }

    const signature = headers['x-hub-signature-256'];
    if (!signature || typeof signature !== 'string') {
      return false;
    }

    return this.webhooks.verify(rawBody, signature);
  }

  async processEvent(
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

  private async fetchPRDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    const response = await this.octokitClient.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: {
        format: 'diff',
      },
    });
    return response.data as unknown as string;
  }

  private async fetchChangedFiles(owner: string, repo: string, prNumber: number): Promise<string> {
    const response = await this.octokitClient.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });
    return response.data.map((file) => file.filename).join('\n');
  }

  private async processPullRequestEvent(
    payload: GithubWebhookPayload,
    logger: FastifyBaseLogger,
  ): Promise<ProcessedWebhookResult> {
    const action = payload.action;
    const owner = payload.repository?.owner?.login || '';
    const repo = payload.repository?.name || '';
    const prNumber = payload.pull_request?.number || 0;

    if (action === 'closed' && (payload.pull_request as any)?.merged) {
      logger.info(`Received GitHub PR merged event: ${payload.pull_request?.html_url}`);

      await this.publishContextBuild({
        provider: 'github',
        owner,
        repo,
        prNumber,
        action: 'merged',
        htmlUrl: payload.pull_request?.html_url || '',
        isIncrementalUpdate: true,
      });

      return {
        ignored: false,
        reason: 'Incremental context build triggered for merged PR',
      };
    }

    if (
      action === 'opened' ||
      action === 'synchronize' ||
      action === 'reopened' ||
      action === 'review_requested'
    ) {
      logger.info(`Received GitHub PR event: ${action} for ${payload.pull_request?.html_url}`);

      const baselineKey = `github:${owner}:${repo}:0`;
      const baselineContext = await this.contextRepository.getContext(baselineKey);

      if (baselineContext && payload.pull_request) {
        // We have baseline context, we can trigger review directly!
        logger.info(`Baseline context exists. Triggering review directly for ${owner}/${repo}#${prNumber}`);
        await this.triggerReview(owner, repo, prNumber, payload.pull_request);
        return { ignored: false, reason: 'Review triggered directly for GitHub' };
      }

      // No baseline context found. Trigger full build context.
      logger.info(`No baseline context found. Triggering full build for ${owner}/${repo}`);
      const baseRef = (payload.pull_request as any)?.base?.ref || 'main';
      const cloneUrl =
        (payload.pull_request as any)?.base?.repo?.clone_url ||
        `https://github.com/${owner}/${repo}.git`;
      await this.publishContextBuild({
        provider: 'github',
        owner,
        repo,
        prNumber,
        action,
        htmlUrl: payload.pull_request?.html_url || '',
        cloneUrl,
        ref: baseRef,
      });

      return { ignored: false, reason: 'Context build triggered for GitHub' };
    }
    return { ignored: true, reason: 'Ignored PR action' };
  }

  async triggerReview(owner: string, repo: string, prNumber: number, prDataParam?: any): Promise<void> {
    await this.prRepository.updatePRStatus(`github:${owner}:${repo}:${prNumber}`, {
      status: 'reviewing',
    });

    const diff = await this.fetchPRDiff(owner, repo, prNumber);
    const changedFiles = await this.fetchChangedFiles(owner, repo, prNumber);

    let prData = prDataParam;
    if (!prData) {
      const response = await this.octokitClient.rest.pulls.get({ owner, repo, pull_number: prNumber });
      prData = response.data;
    }

    const reviewPayload = {
      prMeta: {
        provider: 'github',
        owner,
        repo,
        number: prNumber,
        title: prData.title,
        author: prData.user?.login || prData.user,
        branch: prData.head?.ref || '',
        body: prData.body || '',
      },
      diff,
      changedFiles,
      tickets: [], // TODO: fetch tickets
    };

    const topicName = process.env.REVIEW_CODE_TOPIC || 'review-code-topic';
    await this.pubsubClient.topic(topicName).publishMessage({
      json: reviewPayload,
    });
  }

  private async processIssueCommentEvent(
    payload: GithubWebhookPayload,
    logger: FastifyBaseLogger,
  ): Promise<ProcessedWebhookResult> {
    const action = payload.action;
    if (action === 'created' && payload.issue?.pull_request) {
      const commentBody = payload.comment?.body || '';
      if (commentBody.includes('/review')) {
        logger.info(
          `Received GitHub manual /review trigger on ${payload.issue?.html_url}`,
        );

        const owner = payload.repository?.owner?.login || '';
        const repo = payload.repository?.name || '';
        const prNumber = payload.issue.number;

        const baselineKey = `github:${owner}:${repo}:0`;
        const baselineContext = await this.contextRepository.getContext(baselineKey);

        if (baselineContext) {
           await this.triggerReview(owner, repo, prNumber);
           return { ignored: false, reason: 'Manual review triggered directly' };
        }

        await this.publishContextBuild({
          provider: 'github',
          owner,
          repo,
          prNumber,
          action: 'manual_trigger',
          htmlUrl: payload.issue.pull_request
            ? (payload.issue as any).pull_request.html_url ||
              payload.issue.html_url
            : payload.issue.html_url,
          cloneUrl: `https://github.com/${owner}/${repo}.git`,
          ref: 'main',
        });

        return { ignored: false, reason: 'Manual review context build triggered' };
      }
    }
    return { ignored: true, reason: 'Ignored issue comment action' };
  }

  private async publishContextBuild(
    data: WebhookEventPayload & { provider: string },
  ): Promise<void> {
    const prKey = `${data.provider}:${data.owner}:${data.repo}:${data.prNumber}`;

    await this.prRepository.updatePRStatus(prKey, {
      provider: data.provider,
      owner: data.owner,
      repo: data.repo,
      prNumber: data.prNumber,
      status: 'queued',
    });

    const topicName = process.env.BUILD_CONTEXT_TOPIC || 'build-context-topic';
    await this.pubsubClient.topic(topicName).publishMessage({
      json: data,
    });
  }

  async postInlineComments(
    owner: string,
    repo: string,
    prNumber: number,
    comments: { path: string; position: number; body: string }[],
  ): Promise<void> {
    console.log(`[GithubAdapter] Posting ${comments.length} inline comments to ${owner}/${repo}#${prNumber}`);

    let commit_id: string;
    try {
      const prData = await this.octokitClient.rest.pulls.get({ owner, repo, pull_number: prNumber });
      commit_id = prData.data.head.sha;
    } catch (e) {
      console.error('Failed to fetch PR head sha for comments', e);
      return;
    }

    for (const comment of comments) {
      try {
        await this.octokitClient.rest.pulls.createReviewComment({
          owner,
          repo,
          pull_number: prNumber,
          body: comment.body,
          path: comment.path,
          line: comment.position,
          commit_id,
        });
      } catch (error) {
        console.error(`Failed to post comment to ${comment.path}:${comment.position}`, error);
      }
    }
  }
}
