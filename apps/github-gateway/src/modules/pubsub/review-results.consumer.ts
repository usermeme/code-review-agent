import { PubSub, Message, Subscription } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';
import { GithubService } from '../github/github.service.js';
import { ReviewResultPayload } from 'shared-types';

export interface ReviewResultsConsumerDependencies {
  pubsub: PubSub;
  subscriptionName: string;
  githubService: GithubService;
  logger?: FastifyBaseLogger;
}

export class ReviewResultsConsumer {
  private pubsub: PubSub;
  private subscriptionName: string;
  private githubService: GithubService;
  private subscription?: Subscription;
  private logger?: FastifyBaseLogger;
  private isRunning = false;

  constructor(deps: ReviewResultsConsumerDependencies) {
    this.pubsub = deps.pubsub;
    this.subscriptionName = deps.subscriptionName;
    this.githubService = deps.githubService;
    this.logger = deps.logger;
  }

  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    this.subscription = this.pubsub.subscription(this.subscriptionName);

    this.subscription.on('message', (message: Message) => {
      void (async () => {
        this.logger?.info(
          `[ReviewResultsConsumer] Processing review result message: ${message.id}`,
        );
        try {
          const raw = message.data.toString('utf8');
          const payload = JSON.parse(raw) as ReviewResultPayload;

          if (
            !payload.owner ||
            !payload.repo ||
            typeof payload.prNumber !== 'number'
          ) {
            this.logger?.warn(
              `[ReviewResultsConsumer] Invalid payload structure in message ${message.id}`,
            );
            message.ack();
            return;
          }

          await this.githubService.postReview({
            owner: payload.owner,
            repo: payload.repo,
            prNumber: payload.prNumber,
            summary: payload.summary || '',
            ticketCoverage: payload.ticketCoverage,
            comments: payload.comments || [],
          });

          message.ack();
          this.logger?.info(
            `[ReviewResultsConsumer] Successfully posted review for ${payload.owner}/${payload.repo}#${payload.prNumber} (message: ${message.id})`,
          );
        } catch (error) {
          this.logger?.error(
            `[ReviewResultsConsumer] Error handling message ${message.id}: ${error}`,
          );
          message.nack();
        }
      })();
    });

    this.subscription.on('error', (err) => {
      this.logger?.error(
        `[ReviewResultsConsumer] Subscription error on ${this.subscriptionName}: ${err}`,
      );
    });

    this.logger?.info(
      `[ReviewResultsConsumer] Listening on subscription: ${this.subscriptionName}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.subscription) {
      return;
    }
    this.isRunning = false;
    await this.subscription.close();
    this.logger?.info(
      `[ReviewResultsConsumer] Closed subscription: ${this.subscriptionName}`,
    );
  }
}
