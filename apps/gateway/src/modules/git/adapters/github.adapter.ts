import { Webhooks } from '@octokit/webhooks';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';
import { getSecret } from '../../../services/secrets.service.js';
import { GitAdapter } from '../interfaces/git-adapter.interface.js';
import { ProcessedWebhookResult } from '../../webhooks/interfaces/webhooks.interface.js';
import { WebhookEventPayload } from 'shared-types';
import { PrRepository } from '../../database/repositories/pr.repository.js';

export interface GithubWebhookPayload {
  action?: string;
  pull_request?: {
    number: number;
    html_url: string;
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

export class GithubAdapter implements GitAdapter {
  private webhooks?: Webhooks;
  private pubsub: PubSub;

  constructor(private prRepository: PrRepository) {
    this.pubsub = new PubSub();
  }

  async init(logger: FastifyBaseLogger): Promise<void> {
    const secretName =
      process.env.GITHUB_WEBHOOK_SECRET_ID || 'dummy-secret-for-local-dev';
    let githubSecret = 'dummy';

    if (secretName !== 'dummy-secret-for-local-dev') {
      try {
        githubSecret = await getSecret(secretName);
      } catch (e) {
        logger.error(`Failed to fetch github secret: ${e}`);
      }
    }

    this.webhooks = new Webhooks({ secret: githubSecret });
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

  private async processPullRequestEvent(
    payload: GithubWebhookPayload,
    logger: FastifyBaseLogger,
  ): Promise<ProcessedWebhookResult> {
    const action = payload.action;
    if (action === 'closed' && (payload.pull_request as any)?.merged) {
      logger.info(`Received GitHub PR merged event: ${payload.pull_request?.html_url}`);

      await this.publishContextBuild({
        provider: 'github',
        owner: payload.repository?.owner?.login || '',
        repo: payload.repository?.name || '',
        prNumber: payload.pull_request?.number || 0,
        action: 'merged',
        htmlUrl: payload.pull_request?.html_url || '',
        isIncrementalUpdate: true,
      });

      return { ignored: false, reason: 'Incremental context build triggered for merged PR' };
    }

    if (
      action === 'opened' ||
      action === 'synchronize' ||
      action === 'reopened' ||
      action === 'review_requested'
    ) {
      logger.info(
        `Received GitHub PR event: ${action} for ${payload.pull_request?.html_url}`,
      );

      await this.publishContextBuild({
        provider: 'github',
        owner: payload.repository?.owner?.login || '',
        repo: payload.repository?.name || '',
        prNumber: payload.pull_request?.number || 0,
        action,
        htmlUrl: payload.pull_request?.html_url || '',
      });

      return { ignored: false, reason: 'Context build triggered for GitHub' };
    }
    return { ignored: true, reason: 'Ignored PR action' };
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

        await this.publishContextBuild({
          provider: 'github',
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          prNumber: payload.issue.number,
          action: 'manual_trigger',
          htmlUrl: payload.issue.pull_request
            ? (payload.issue as any).pull_request.html_url ||
              payload.issue.html_url
            : payload.issue.html_url,
        });

        return { ignored: false, reason: 'Manual review triggered for GitHub' };
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
    await this.pubsub.topic(topicName).publishMessage({
      json: data,
    });
  }

  async postInlineComments(
    owner: string,
    repo: string,
    prNumber: number,
    comments: { path: string; position: number; body: string }[],
  ): Promise<void> {
    // TODO: implement actual GitHub API call using octokit
    console.log(
      `[GithubAdapter] Posting ${comments.length} inline comments to ${owner}/${repo}#${prNumber}`,
    );
  }
}
