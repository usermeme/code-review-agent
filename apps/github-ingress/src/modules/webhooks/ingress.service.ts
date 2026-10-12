import { PREventPayload } from '@code-review-agent/shared-types';
import { PubSub } from '@google-cloud/pubsub';
import { Webhooks } from '@octokit/webhooks';
import { FastifyBaseLogger } from 'fastify';

import type { IngressEnvService } from '../../env.js';
import {
  GithubWebhookPayload,
  ProcessedWebhookResult,
} from './interfaces/webhooks.interface.js';

export interface GithubIngressServiceDependencies {
  envService: IngressEnvService;
  pubsub: PubSub;
  webhookSecret?: string;
  webhooks?: Webhooks;
}

export class GithubIngressService {
  private webhooks: Webhooks;
  private pubsub: PubSub;
  private envService: IngressEnvService;

  constructor(deps: GithubIngressServiceDependencies) {
    this.envService = deps.envService;
    this.pubsub = deps.pubsub;

    const webhookSecret =
      deps.webhookSecret ?? deps.envService.get('GITHUB_WEBHOOK_SECRET');

    this.webhooks = deps.webhooks ?? new Webhooks({ secret: webhookSecret });
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
    const owner = payload.repository?.owner?.login || '';
    const repo = payload.repository?.name || '';
    const prNumber = payload.pull_request?.number || 0;

    if (!owner || !repo || !prNumber) {
      return { ignored: true, reason: 'Missing PR owner, repo or number' };
    }

    if (action === 'closed' && payload.pull_request?.merged) {
      logger.info(
        `Received GitHub PR merged event: ${payload.pull_request.html_url}`,
      );

      const eventPayload: PREventPayload = {
        prMeta: {
          provider: 'github',
          owner,
          repo,
          prNumber,
          title: payload.pull_request.title || '',
          author: payload.pull_request.user?.login || '',
          branch: payload.pull_request.head?.ref || '',
          body: payload.pull_request.body || '',
          htmlUrl: payload.pull_request.html_url || '',
          action: 'closed',
          cloneUrl:
            payload.pull_request.base?.repo?.clone_url ||
            `https://github.com/${owner}/${repo}.git`,
          baseRef: payload.pull_request.base?.ref || 'main',
          isIncrementalUpdate: true,
        },
        diff: '',
        changedFiles: [],
      };

      await this.publishPREvent(eventPayload);
      return { ignored: false, reason: 'PR merged event published to queue' };
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

      const eventPayload: PREventPayload = {
        prMeta: {
          provider: 'github',
          owner,
          repo,
          prNumber,
          title: payload.pull_request?.title || '',
          author: payload.pull_request?.user?.login || '',
          branch: payload.pull_request?.head?.ref || '',
          body: payload.pull_request?.body || '',
          htmlUrl: payload.pull_request?.html_url || '',
          action,
          cloneUrl:
            payload.pull_request?.base?.repo?.clone_url ||
            `https://github.com/${owner}/${repo}.git`,
          baseRef: payload.pull_request?.base?.ref || 'main',
          isIncrementalUpdate: false,
        },
        diff: '',
        changedFiles: [],
      };

      await this.publishPREvent(eventPayload);
      return { ignored: false, reason: 'PR event published to queue' };
    }

    return { ignored: true, reason: `Ignored PR action: ${action}` };
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
          `Received GitHub manual /review trigger on ${payload.issue.html_url}`,
        );

        const owner = payload.repository?.owner?.login || '';
        const repo = payload.repository?.name || '';
        const prNumber = payload.issue.number;

        const eventPayload: PREventPayload = {
          prMeta: {
            provider: 'github',
            owner,
            repo,
            prNumber,
            title: '',
            author: '',
            branch: '',
            body: '',
            htmlUrl: payload.issue.html_url,
            action: 'manual_trigger',
            cloneUrl: `https://github.com/${owner}/${repo}.git`,
            baseRef: 'main',
            isIncrementalUpdate: false,
          },
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
    return { ignored: true, reason: 'Ignored issue comment action' };
  }
}
