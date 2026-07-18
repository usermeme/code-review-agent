import { FastifyBaseLogger } from 'fastify';
import { ProcessedWebhookResult } from './interfaces/webhooks.interface.js';
import { GitAdapter } from '../git/interfaces/git-adapter.interface.js';
import { GitService } from '../git/git.service.js';

export class WebhooksService {
  constructor(private gitService: GitService) {}

  /**
   * Initializes all registered adapters.
   */
  async init(logger: FastifyBaseLogger): Promise<void> {
    await this.gitService.initAdapters(logger);
  }

  /**
   * Finds the appropriate adapter for the incoming webhook.
   */
  getAdapterForRequest(
    headers: Record<string, string | string[] | undefined>,
  ): GitAdapter | undefined {
    return this.gitService.getAdapterForRequest(headers)?.adapter;
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
