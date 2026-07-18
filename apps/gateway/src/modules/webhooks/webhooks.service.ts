import { FastifyBaseLogger } from 'fastify';
import { ProcessedWebhookResult } from './interfaces/webhooks.interface.js';
import { GitAdapter } from './interfaces/git-adapter.interface.js';

export class WebhooksService {
  constructor(private adapters: GitAdapter[] = []) {}

  /**
   * Initializes all registered adapters.
   */
  async init(logger: FastifyBaseLogger): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.init(logger);
    }
  }

  /**
   * Finds the appropriate adapter for the incoming webhook.
   */
  getAdapterForRequest(
    headers: Record<string, string | string[] | undefined>,
  ): GitAdapter | undefined {
    return this.adapters.find((adapter) => adapter.canHandle(headers));
  }

  /**
   * Verifies the cryptographic signature of the webhook payload using the appropriate adapter.
   */
  async verifySignature(
    adapter: GitAdapter,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<boolean> {
    return adapter.verifySignature(headers, rawBody);
  }

  /**
   * Processes the parsed payload using the appropriate adapter.
   */
  async processEvent(
    adapter: GitAdapter,
    headers: Record<string, string | string[] | undefined>,
    payload: unknown,
    logger: FastifyBaseLogger,
  ): Promise<ProcessedWebhookResult> {
    return adapter.processEvent(headers, payload, logger);
  }
}
