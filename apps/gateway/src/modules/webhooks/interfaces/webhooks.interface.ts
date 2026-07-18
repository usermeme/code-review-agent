import { WebhookEventPayload } from 'shared-types';

export interface ProcessedWebhookResult {
  ignored: boolean;
  reason?: string;
  payload?: WebhookEventPayload;
}

export { WebhookEventPayload };
