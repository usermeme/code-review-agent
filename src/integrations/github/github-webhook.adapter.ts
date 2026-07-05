import { Webhooks } from '@octokit/webhooks';
import type { WebhookAdapter, WebhookRequest, NormalizedWebhookEvent, NormalizedEventType } from '../vcs/interfaces/webhook-adapter.interface.js';
import type { ProviderId, RepositoryIdentifier } from '../vcs/types/vcs.types.js';

interface GithubPayload {
  action?: string;
  pull_request?: { number: number; draft?: boolean };
  issue?: { number: number; pull_request?: Record<string, unknown> };
  repository?: { full_name: string };
  installation?: { id: number };
  comment?: { id: number; body: string; user?: { login: string }; created_at: string; path?: string };
  review?: { id: number; body: string | null; user?: { login: string }; submitted_at?: string };
  sender?: { type: string };
}

export class GithubWebhookAdapter implements WebhookAdapter {
  readonly providerId: ProviderId = 'github';

  canHandle(req: WebhookRequest): boolean {
    return 'x-github-event' in req.headers;
  }

  async verifySignature(req: WebhookRequest, secret: string): Promise<boolean> {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;
    
    const webhooks = new Webhooks({ secret });
    return webhooks.verify(req.rawBody, signature);
  }

  private mapEventType(eventName: string, action?: string): NormalizedEventType | null {
    switch (eventName) {
      case 'pull_request':
        if (action === 'opened' || action === 'ready_for_review') return 'pull_request_opened';
        if (action === 'closed') return 'pull_request_closed';
        if (action === 'synchronize') return 'pull_request_updated';
        return null;
      case 'issue_comment':
        return 'issue_comment';
      case 'pull_request_review':
        return 'pull_request_review';
      case 'pull_request_review_comment':
        return 'pull_request_review_comment';
      default:
        return null;
    }
  }

  parseEvent(req: WebhookRequest): NormalizedWebhookEvent | null {
    const eventName = req.headers['x-github-event'];
    if (!eventName || typeof eventName !== 'string') return null;

    const payload = req.body as GithubPayload;
    
    const eventType = this.mapEventType(eventName, payload.action);
    if (!eventType || !payload.repository?.full_name || !payload.installation?.id) {
      return null;
    }

    const [owner, name] = payload.repository.full_name.split('/');
    if (!owner || !name) return null;
    
    const repo: RepositoryIdentifier = {
      provider: this.providerId,
      owner,
      name,
    };

    const commentOrReviewBody = payload.comment?.body ?? payload.review?.body ?? undefined;
    const authorLogin = payload.comment?.user?.login ?? payload.review?.user?.login;
    const commentId = payload.comment?.id ?? payload.review?.id;
    const timestamp = payload.comment?.created_at ?? payload.review?.submitted_at;

    return {
      provider: this.providerId,
      eventType,
      installationId: String(payload.installation.id),
      repo,
      pullRequestNumber: payload.pull_request?.number,
      issueNumber: payload.issue?.number,
      
      action: payload.action,
      isDraft: Boolean(payload.pull_request?.draft),
      isPr: Boolean(payload.issue?.pull_request),
      body: commentOrReviewBody,
      author: authorLogin,
      providerCommentId: commentId ? String(commentId) : undefined,
      filePath: payload.comment?.path,
      createdAt: timestamp,
      senderType: payload.sender?.type,
    };
  }
}
