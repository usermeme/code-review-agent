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

  parseEvent(req: WebhookRequest): NormalizedWebhookEvent | null {
    const eventName = req.headers['x-github-event'];
    const payload = req.body as GithubPayload;
    
    let eventType: NormalizedEventType | null = null;
    const prNumber = payload.pull_request?.number;
    const issueNumber = payload.issue?.number;

    if (eventName === 'pull_request') {
      if (payload.action === 'opened' || payload.action === 'ready_for_review') {
        eventType = 'pull_request_opened';
      } else if (payload.action === 'closed') {
        eventType = 'pull_request_closed';
      } else if (payload.action === 'synchronize') {
        eventType = 'pull_request_updated';
      }
    } else if (eventName === 'issue_comment') {
      eventType = 'issue_comment';
    } else if (eventName === 'pull_request_review') {
      eventType = 'pull_request_review';
    } else if (eventName === 'pull_request_review_comment') {
      eventType = 'pull_request_review_comment';
    }

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

    return {
      provider: this.providerId,
      eventType,
      installationId: String(payload.installation.id),
      repo,
      pullRequestNumber: prNumber,
      issueNumber,
      
      action: payload.action,
      isDraft: Boolean(payload.pull_request?.draft),
      isPr: Boolean(payload.issue?.pull_request),
      body: payload.comment?.body ?? payload.review?.body ?? undefined,
      author: payload.comment?.user?.login ?? payload.review?.user?.login,
      providerCommentId: payload.comment?.id ? String(payload.comment.id) : (payload.review?.id ? String(payload.review.id) : undefined),
      filePath: payload.comment?.path,
      createdAt: payload.comment?.created_at ?? payload.review?.submitted_at,
      senderType: payload.sender?.type,
    };
  }
}
