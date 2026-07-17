import { FastifyBaseLogger } from 'fastify';
import { ProcessedWebhookResult } from './webhooks.interface.js';

export interface GitAdapter {
  /**
   * Initialize the adapter, fetch secrets, etc.
   */
  init(logger: FastifyBaseLogger): Promise<void>;

  /**
   * Determine if this adapter can handle the incoming webhook based on headers.
   */
  canHandle(headers: Record<string, string | string[] | undefined>): boolean;

  /**
   * Verify the cryptographic signature of the incoming webhook.
   */
  verifySignature(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean>;

  /**
   * Process the webhook event and optionally publish to PubSub.
   */
  processEvent(headers: Record<string, string | string[] | undefined>, payload: any, logger: FastifyBaseLogger): Promise<ProcessedWebhookResult>;
}
