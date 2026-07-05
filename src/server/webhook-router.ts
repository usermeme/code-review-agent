import { Webhooks } from '@octokit/webhooks';
import PQueue from 'p-queue';
import { runReview } from '../agents/run-review.js';
import { acquireReviewLock, releaseReviewLock } from '../cache/redis.js';
import type { DiscussionEntry } from '../discussions/store.js';
import { logger } from '../util/logger.js';
import type { Services } from '../wiring.js';

export function repoAllowed(fullName: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((pattern) => {
    const regex = new RegExp(
      '^' +
        pattern
          .split('*')
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*') +
        '$',
    );
    return regex.test(fullName);
  });
}

function prNumberFromUrl(url: string | undefined): number | undefined {
  const match = /\/(?:pulls|issues)\/(\d+)$/.exec(url ?? '');
  return match ? Number(match[1]) : undefined;
}

interface GithubUser {
  login?: string;
  type?: string;
}

/** The subset of GitHub webhook payload fields this router reads. */
export interface WebhookPayload {
  action?: string;
  repository?: { full_name?: string };
  installation?: { id?: number };
  sender?: GithubUser;
  pull_request?: { number?: number; draft?: boolean };
  issue?: { number?: number; pull_request?: unknown };
  comment?: {
    id?: number;
    body?: string;
    user?: GithubUser;
    path?: string;
    created_at?: string;
    issue_url?: string;
  };
  review?: {
    id?: number;
    body?: string | null;
    user?: GithubUser;
    submitted_at?: string;
  };
}

export class WebhookRouter {
  private readonly webhooks: Webhooks;
  private readonly queue: PQueue;

  constructor(private readonly services: Services) {
    this.webhooks = new Webhooks({ secret: services.cfg.github.webhookSecret });
    this.queue = new PQueue({ concurrency: services.cfg.server.concurrency });
  }

  verify(rawBody: string, signature: string): Promise<boolean> {
    return this.webhooks.verify(rawBody, signature);
  }

  /** Routes a verified webhook. Returns fast; heavy work goes onto the queue. */
  route(eventName: string, payload: WebhookPayload): void {
    const repoFullName = payload.repository?.full_name;
    if (repoFullName && !repoAllowed(repoFullName, this.services.cfg.github.reposAllowlist)) {
      logger.debug({ repo: repoFullName }, 'repo not in allowlist; ignoring event');
      return;
    }

    switch (eventName) {
      case 'pull_request':
        this.handlePullRequest(payload);
        break;
      case 'issue_comment':
        this.handleIssueComment(payload);
        break;
      case 'pull_request_review_comment':
        if (payload.action === 'created') {
          this.ingest(payload, {
            source: 'review_comment',
            body: payload.comment?.body,
            author: payload.comment?.user?.login,
            githubId: payload.comment?.id,
            filePath: payload.comment?.path,
            prNumber: payload.pull_request?.number,
            createdAt: payload.comment?.created_at,
          });
        }
        break;
      case 'pull_request_review':
        if (payload.action === 'submitted') {
          this.ingest(payload, {
            source: 'review',
            body: payload.review?.body ?? undefined,
            author: payload.review?.user?.login,
            githubId: payload.review?.id,
            prNumber: payload.pull_request?.number,
            createdAt: payload.review?.submitted_at,
          });
        }
        break;
      default:
        break;
    }
  }

  private handlePullRequest(payload: WebhookPayload): void {
    const triggers = this.services.cfg.triggers;
    const isDraft = Boolean(payload.pull_request?.draft);
    const shouldReview =
      (payload.action === 'opened' && triggers.onOpened && !isDraft) ||
      (payload.action === 'ready_for_review' && triggers.onReadyForReview);
    if (!shouldReview) return;
    this.enqueueReview(payload, payload.pull_request?.number);
  }

  private handleIssueComment(payload: WebhookPayload): void {
    if (payload.action !== 'created') return;
    const isPr = Boolean(payload.issue?.pull_request);
    if (!isPr) return;
    const body = payload.comment?.body ?? '';

    this.ingest(payload, {
      source: 'issue_comment',
      body,
      author: payload.comment?.user?.login,
      githubId: payload.comment?.id,
      prNumber: payload.issue?.number,
      createdAt: payload.comment?.created_at,
    });

    const command = this.services.cfg.triggers.reviewCommand;
    if (payload.sender?.type !== 'Bot' && body.trimStart().startsWith(command)) {
      this.enqueueReview(payload, payload.issue?.number);
    }
  }

  private enqueueReview(payload: WebhookPayload, prNumber: number | undefined): void {
    const installationId = payload.installation?.id;
    const [owner, repo] = (payload.repository?.full_name ?? '').split('/');
    if (!installationId || !owner || !repo || !prNumber) {
      logger.warn({ owner, repo, prNumber, installationId }, 'cannot enqueue review: missing fields');
      return;
    }
    void this.queue.add(() => this.reviewJob(installationId, owner, repo, prNumber));
  }

  private async reviewJob(installationId: number, owner: string, repo: string, prNumber: number): Promise<void> {
    const { redis, app, reviewDeps } = this.services;
    const repoFull = `${owner}/${repo}`;
    let headSha = 'unknown';
    let lockToken: string | null = null;
    try {
      const octokit = await app.getInstallationOctokit(installationId);
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      headSha = pr.head.sha;
      lockToken = await acquireReviewLock(redis, repoFull, prNumber, headSha);
      if (!lockToken) {
        logger.info({ repo: repoFull, pr: prNumber, headSha }, 'review already ran for this sha; skipping');
        return;
      }
      await runReview(reviewDeps, { installationId, owner, repo, prNumber });
    } catch (error) {
      logger.error({ repo: repoFull, pr: prNumber, err: error }, 'review failed');
      // Release the lock so a manual /review can retry the same sha.
      if (lockToken) {
        await releaseReviewLock(redis, repoFull, prNumber, headSha, lockToken).catch(() => {});
      }
    }
  }

  /** Every human PR discussion comment feeds the vector store (bots excluded). */
  private ingest(
    payload: WebhookPayload,
    entry: {
      source: DiscussionEntry['source'];
      body?: string;
      author?: string;
      githubId?: number;
      filePath?: string;
      prNumber?: number;
      createdAt?: string;
    },
  ): void {
    if (!entry.body?.trim() || payload.sender?.type === 'Bot') return;
    void this.services.discussionStore
      .insert({
        repo: payload.repository?.full_name ?? '',
        prNumber: entry.prNumber ?? prNumberFromUrl(payload.comment?.issue_url),
        source: entry.source,
        author: entry.author ?? 'unknown',
        filePath: entry.filePath,
        body: entry.body,
        githubId: entry.githubId,
        createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(),
      })
      .catch((error: unknown) => logger.warn({ err: error }, 'failed to ingest discussion'));
  }
}
