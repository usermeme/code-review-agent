import type { ProviderId, RepositoryIdentifier } from '../types/vcs.types.js';

export interface WebhookRequest {
  headers: Record<string, string>;
  rawBody: string; // Needed for signature verification
  body: unknown; // Parsed JSON payload
}

export type NormalizedEventType =
  | 'pull_request_opened'
  | 'pull_request_updated'
  | 'pull_request_closed'
  | 'issue_comment'
  | 'pull_request_review'
  | 'pull_request_review_comment';

export interface NormalizedWebhookEvent {
  provider: ProviderId;
  eventType: NormalizedEventType;
  installationId: string;
  repo: RepositoryIdentifier;
  pullRequestNumber?: number;
  issueNumber?: number; // In case of pure issue comments

  // Extracted generic fields
  action?: string;
  isDraft?: boolean;
  isPr?: boolean;
  body?: string;
  author?: string;
  providerCommentId?: string;
  filePath?: string;
  createdAt?: string;
  senderType?: string;
}

export interface WebhookAdapter {
  readonly providerId: ProviderId;

  // 1. Inspect headers to see if adapter applies
  canHandle(req: WebhookRequest): boolean;

  // 2. Perform cryptographic signature verification
  verifySignature(req: WebhookRequest, secret: string): Promise<boolean>;

  // 3. Map the proprietary payload structure into a standard system event
  parseEvent(req: WebhookRequest): NormalizedWebhookEvent | null;
}
