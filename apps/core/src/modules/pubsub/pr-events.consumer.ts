import { PubSub, Message, Subscription } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { PREventPayload } from 'shared-types';

export interface PrEventsConsumerDependencies {
  pubsub: PubSub;
  subscriptionName: string;
  orchestrator: EventOrchestratorService;
  logger?: FastifyBaseLogger;
}

export class PrEventsConsumer {
  private pubsub: PubSub;
  private subscriptionName: string;
  private orchestrator: EventOrchestratorService;
  private subscription?: Subscription;
  private logger?: FastifyBaseLogger;
  private isRunning = false;

  constructor(deps: PrEventsConsumerDependencies) {
    this.pubsub = deps.pubsub;
    this.subscriptionName = deps.subscriptionName;
    this.orchestrator = deps.orchestrator;
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
          `[PrEventsConsumer] Processing PR event message: ${message.id}`,
        );
        try {
          const raw = message.data.toString('utf8');
          const payload = JSON.parse(raw) as PREventPayload;

          if (
            !payload.prMeta ||
            !payload.prMeta.owner ||
            !payload.prMeta.repo
          ) {
            this.logger?.warn(
              `[PrEventsConsumer] Invalid payload structure in message ${message.id}`,
            );
            message.ack();
            return;
          }

          await this.orchestrator.ingestPREvent(payload, this.logger);

          message.ack();
          this.logger?.info(
            `[PrEventsConsumer] Successfully processed PR event ${payload.prMeta.owner}/${payload.prMeta.repo}#${payload.prMeta.prNumber} (message: ${message.id})`,
          );
        } catch (error) {
          this.logger?.error(
            `[PrEventsConsumer] Error processing PR event message ${message.id}: ${error}`,
          );
          message.nack();
        }
      })();
    });

    this.subscription.on('error', (err) => {
      this.logger?.error(
        `[PrEventsConsumer] Subscription error on ${this.subscriptionName}: ${err}`,
      );
    });

    this.logger?.info(
      `[PrEventsConsumer] Listening on subscription: ${this.subscriptionName}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.subscription) {
      return;
    }
    this.isRunning = false;
    await this.subscription.close();
    this.logger?.info(
      `[PrEventsConsumer] Closed subscription: ${this.subscriptionName}`,
    );
  }
}
