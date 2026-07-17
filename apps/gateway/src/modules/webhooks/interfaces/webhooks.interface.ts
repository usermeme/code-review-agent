export interface WebhookEventPayload {
  owner: string;
  repo: string;
  prNumber: number;
  action: string;
}

export interface ProcessedWebhookResult {
  status: string;
}
