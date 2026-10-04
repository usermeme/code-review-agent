import { Webhooks } from '@octokit/webhooks';
import { Octokit } from '@octokit/rest';
import { FastifyBaseLogger } from 'fastify';
import {
  PostReviewOptions,
  PostReviewResult,
  GithubWebhookPayload,
} from './interfaces/github.interface.js';
import { ProcessedWebhookResult } from '../webhooks/interfaces/webhooks.interface.js';
import { Client } from '@connectrpc/connect';
import { CoreService, IngestPREventRequest } from 'contracts';
import { envService as defaultEnvService, GatewayEnvService } from '../../env.js';

export interface GithubServiceDependencies {
  octokit?: Octokit;
  coreClient: Client<typeof CoreService>;
  webhookSecret?: string;
  token?: string;
  envService?: GatewayEnvService;
}

export class GithubService {
  private webhooks: Webhooks;
  private octokit: Octokit;
  private coreClient: Client<typeof CoreService>;

  constructor(deps: GithubServiceDependencies) {
    this.coreClient = deps.coreClient;
    const env = deps.envService ?? defaultEnvService;

    const webhookSecret = deps.webhookSecret ?? env.get('GIT_ADAPTER_WEBHOOK_SECRET');
    const token = deps.token ?? env.get('GIT_ADAPTER_TOKEN');

    this.webhooks = new Webhooks({ secret: webhookSecret });
    this.octokit = deps.octokit ?? new Octokit({ auth: token });
  }

  private get octokitClient(): Octokit {
    return this.octokit;
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

  private async fetchPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string> {
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

  private async fetchChangedFiles(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string[]> {
    const response = await this.octokitClient.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });
    return response.data.map((file) => file.filename);
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
      logger.info(`Received GitHub PR merged event: ${payload.pull_request.html_url}`);

      const req: IngestPREventRequest = {
        $typeName: 'core.v1.IngestPREventRequest',
        prMeta: {
          $typeName: 'core.v1.PRMeta',
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

      const res = await this.coreClient.ingestPREvent(req);
      return { ignored: false, reason: res.message };
    }

    if (
      action === 'opened' ||
      action === 'synchronize' ||
      action === 'reopened' ||
      action === 'review_requested'
    ) {
      logger.info(`Received GitHub PR event: ${action} for ${payload.pull_request?.html_url}`);

      const diff = await this.fetchPRDiff(owner, repo, prNumber);
      const changedFiles = await this.fetchChangedFiles(owner, repo, prNumber);

      const req: IngestPREventRequest = {
        $typeName: 'core.v1.IngestPREventRequest',
        prMeta: {
          $typeName: 'core.v1.PRMeta',
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
        diff,
        changedFiles,
      };

      const res = await this.coreClient.ingestPREvent(req);
      return { ignored: false, reason: res.message };
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
        logger.info(`Received GitHub manual /review trigger on ${payload.issue.html_url}`);

        const owner = payload.repository?.owner?.login || '';
        const repo = payload.repository?.name || '';
        const prNumber = payload.issue.number;

        const prData = await this.octokitClient.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        });

        const diff = await this.fetchPRDiff(owner, repo, prNumber);
        const changedFiles = await this.fetchChangedFiles(owner, repo, prNumber);

        const req: IngestPREventRequest = {
          $typeName: 'core.v1.IngestPREventRequest',
          prMeta: {
            $typeName: 'core.v1.PRMeta',
            provider: 'github',
            owner,
            repo,
            prNumber,
            title: prData.data.title,
            author: prData.data.user?.login || '',
            branch: prData.data.head?.ref || '',
            body: prData.data.body || '',
            htmlUrl: prData.data.html_url,
            action: 'manual_trigger',
            cloneUrl: prData.data.base?.repo?.clone_url || `https://github.com/${owner}/${repo}.git`,
            baseRef: prData.data.base?.ref || 'main',
            isIncrementalUpdate: false,
          },
          diff,
          changedFiles,
        };

        const res = await this.coreClient.ingestPREvent(req);
        return { ignored: false, reason: res.message };
      }
    }
    return { ignored: true, reason: 'Ignored issue comment action' };
  }

  async postReview(options: PostReviewOptions): Promise<PostReviewResult> {
    const { owner, repo, prNumber, summary, ticketCoverage, comments } = options;

    console.log(`[GithubService] Posting top-level review summary to ${owner}/${repo}#${prNumber}`);

    let body = `## 🤖 AI Code Review Summary\n\n${summary}`;
    if (ticketCoverage) {
      body += `\n\n### 🎯 Ticket & Requirements Coverage\n\n${ticketCoverage}`;
    }
    if (comments && comments.length > 0) {
      const plural = comments.length === 1 ? '' : 's';
      body += `\n\n---\n*Found ${comments.length} inline review comment${plural}.*`;
    }

    let commit_id: string | undefined;
    try {
      const prData = await this.octokitClient.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      commit_id = prData.data.head.sha;
    } catch (e) {
      console.warn('Failed to fetch PR head sha for review summary', e);
    }

    let reviewId: string;
    try {
      const reviewRes = await this.octokitClient.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body,
        event: 'COMMENT',
        ...(commit_id ? { commit_id } : {}),
      });
      reviewId = String(reviewRes.data.id);
      console.log(
        `[GithubService] Submitted formal review to ${owner}/${repo}#${prNumber}, id: ${reviewId}`,
      );
    } catch (reviewErr) {
      console.warn(
        `[GithubService] Failed to submit formal PR review, falling back to issue comment:`,
        reviewErr,
      );
      try {
        const commentRes = await this.octokitClient.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        });
        reviewId = String(commentRes.data.id);
      } catch (commentErr) {
        console.error(
          `[GithubService] Failed to post issue comment fallback:`,
          commentErr,
        );
        return {
          success: false,
          message: `Failed to post review: ${reviewErr}`,
        };
      }
    }

    // Post inline comments if commit_id is available
    if (commit_id && comments && comments.length > 0) {
      console.log(
        `[GithubService] Posting ${comments.length} inline comments to ${owner}/${repo}#${prNumber}`,
      );
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
          console.error(
            `Failed to post comment to ${comment.path}:${comment.position}`,
            error,
          );
        }
      }
    }

    return {
      success: true,
      message: 'Review posted successfully',
      reviewId,
    };
  }
}
