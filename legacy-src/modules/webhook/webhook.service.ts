import PQueue from 'p-queue';
import { runReview } from '../review/review.service.js';
import type { DiscussionEntry } from '../discussion/store.service.js';
import { logger } from '../../core/logger/logger.service.js';
import type { Services } from '../../wiring.js';
import {
  acquireReviewLock,
  releaseReviewLock,
} from '../review/review-lock.service.js';
import type {
  WebhookRequest,
  NormalizedWebhookEvent,
} from '../../integrations/vcs/interfaces/webhook-adapter.interface.js';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegExp(pattern: string): RegExp {
  const regexString =
    '^' + pattern.split('*').map(escapeRegExp).join('[^/]*') + '$';
  return new RegExp(regexString);
}

export function repoAllowed(fullName: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((pattern) => patternToRegExp(pattern).test(fullName));
}

export class WebhookRouter {
  private readonly queue: PQueue;

  constructor(private readonly services: Services) {
    this.queue = new PQueue({ concurrency: services.cfg.server.concurrency });
  }

  private getWebhookSecret(providerId: string): string {
    const providersConfig = this.services.cfg.providers as Record<
      string,
      { webhookSecret?: string }
    >;
    const secret = providersConfig[providerId]?.webhookSecret;
    if (!secret) {
      throw new Error(
        `webhook secret not configured for provider ${providerId}`,
      );
    }
    return secret;
  }

  async handle(req: WebhookRequest): Promise<boolean> {
    for (const adapter of this.services.webhookAdapters) {
      if (adapter.canHandle(req)) {
        const secret = this.getWebhookSecret(adapter.providerId);
        if (!(await adapter.verifySignature(req, secret))) {
          throw new Error('invalid signature');
        }

        const event = adapter.parseEvent(req);
        if (event) {
          this.route(event);
        }
        return true;
      }
    }
    return false;
  }

  route(event: NormalizedWebhookEvent): void {
    const repoFullName = `${event.repo.owner}/${event.repo.name}`;
    if (
      !repoAllowed(
        repoFullName,
        this.services.cfg.providers.github.reposAllowlist,
      )
    ) {
      logger.debug(
        { repo: repoFullName },
        'repo not in allowlist; ignoring event',
      );
      return;
    }

    switch (event.eventType) {
      case 'pull_request_opened':
      case 'pull_request_updated':
        this.handlePullRequest(event);
        break;
      case 'issue_comment':
        this.handleIssueComment(event);
        break;
      case 'pull_request_review_comment':
      case 'pull_request_review':
        this.handleReview(event);
        break;
    }
  }

  private handlePullRequest(event: NormalizedWebhookEvent): void {
    const triggers = this.services.cfg.triggers;
    const isDraft = Boolean(event.isDraft);

    const shouldReview =
      (event.eventType === 'pull_request_opened' &&
        triggers.onOpened &&
        !isDraft) ||
      (event.action === 'ready_for_review' && triggers.onReadyForReview);

    if (!shouldReview) return;
    this.enqueueReview(event);
  }

  private handleIssueComment(event: NormalizedWebhookEvent): void {
    if (event.action !== 'created') return;
    const isPr = Boolean(event.isPr);
    if (!isPr) return;
    const body = event.body ?? '';

    this.ingest(event, {
      source: 'issue_comment',
      body,
      author: event.author,
      providerId: event.providerCommentId,
      prNumber: event.issueNumber,
      createdAt: event.createdAt,
    });

    const command = this.services.cfg.triggers.reviewCommand;
    if (event.senderType !== 'Bot' && body.trimStart().startsWith(command)) {
      this.enqueueReview(event);
    }
  }

  private handleReview(event: NormalizedWebhookEvent): void {
    if (
      event.eventType === 'pull_request_review_comment' &&
      event.action === 'created'
    ) {
      this.ingest(event, {
        source: 'review_comment',
        body: event.body,
        author: event.author,
        providerId: event.providerCommentId,
        filePath: event.filePath,
        prNumber: event.pullRequestNumber,
        createdAt: event.createdAt,
      });
    } else if (
      event.eventType === 'pull_request_review' &&
      event.action === 'submitted'
    ) {
      this.ingest(event, {
        source: 'review',
        body: event.body ?? undefined,
        author: event.author,
        providerId: event.providerCommentId,
        prNumber: event.pullRequestNumber,
        createdAt: event.createdAt,
      });
    }
  }

  private enqueueReview(event: NormalizedWebhookEvent): void {
    if (!event.installationId || !event.pullRequestNumber) {
      logger.warn({ event }, 'cannot enqueue review: missing fields');
      return;
    }
    void this.queue.add(() => this.reviewJob(event));
  }

  private async reviewJob(event: NormalizedWebhookEvent): Promise<void> {
    const { redis, reviewDeps, getProvider } = this.services;
    const repoFull = `${event.repo.owner}/${event.repo.name}`;
    let headSha = 'unknown';
    let lockToken: string | null = null;
    try {
      const provider = getProvider(event.provider);
      const client = await provider.getClient(event.installationId);
      const prDetails = await client.getPullRequest(
        event.repo,
        event.pullRequestNumber!,
      );
      headSha = prDetails.headSha;

      lockToken = await acquireReviewLock(
        redis,
        repoFull,
        event.pullRequestNumber!,
        headSha,
      );
      if (!lockToken) {
        logger.info(
          { repo: repoFull, pr: event.pullRequestNumber, headSha },
          'review already ran for this sha; skipping',
        );
        return;
      }

      await runReview(reviewDeps, {
        providerId: event.provider,
        installationId: event.installationId,
        repo: event.repo,
        prNumber: event.pullRequestNumber!,
      });
    } catch (error) {
      logger.error(
        { repo: repoFull, pr: event.pullRequestNumber, err: error },
        'review failed',
      );
      if (lockToken && event.pullRequestNumber) {
        await releaseReviewLock(
          redis,
          repoFull,
          event.pullRequestNumber,
          headSha,
          lockToken,
        ).catch(() => {});
      }
    }
  }

  private ingest(
    event: NormalizedWebhookEvent,
    entry: {
      source: DiscussionEntry['source'];
      body?: string;
      author?: string;
      providerId?: string;
      filePath?: string;
      prNumber?: number;
      createdAt?: string;
    },
  ): void {
    if (!entry.body?.trim() || event.senderType === 'Bot') return;
    void this.services.discussionStore
      .insert({
        repo: `${event.repo.owner}/${event.repo.name}`,
        prNumber: entry.prNumber,
        source: entry.source,
        author: entry.author ?? 'unknown',
        filePath: entry.filePath,
        body: entry.body,
        providerId: entry.providerId ? String(entry.providerId) : undefined, // Mapping providerId to providerId
        platformInstallationId: event.installationId,
        createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(),
      })
      .catch((error: unknown) =>
        logger.warn({ err: error }, 'failed to ingest discussion'),
      );
  }
}
