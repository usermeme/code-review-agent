import { PubSub, Message, Subscription } from '@google-cloud/pubsub';

export interface BaseConsumerLogger {
  info(msg: string, ...args: any[]): void;
  warn(msg: string, ...args: any[]): void;
  error(msg: string | Error, ...args: any[]): void;
}

export interface BaseConsumerDependencies {
  pubsub: PubSub;
  subscriptionName: string;
  logger?: BaseConsumerLogger;
}

export abstract class AbstractPubSubConsumer<TPayload> {
  protected pubsub: PubSub;
  protected subscriptionName: string;
  protected logger?: BaseConsumerLogger;
  protected subscription?: Subscription;
  protected isRunning = false;
  protected abstract readonly consumerName: string;

  constructor(deps: BaseConsumerDependencies) {
    this.pubsub = deps.pubsub;
    this.subscriptionName = deps.subscriptionName;
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
          `[${this.consumerName}] Processing message: ${message.id}`,
        );
        try {
          const raw = message.data.toString('utf8');
          const payload = JSON.parse(raw) as TPayload;

          if (!this.isValidPayload(payload)) {
            this.logger?.warn(
              `[${this.consumerName}] Invalid payload structure in message ${message.id}`,
            );
            message.ack();
            return;
          }

          await this.handlePayload(payload, message);

          message.ack();
          this.logger?.info(
            `[${this.consumerName}] Successfully processed message: ${message.id}`,
          );
        } catch (error) {
          this.logger?.error(
            `[${this.consumerName}] Error processing message ${message.id}: ${String(error)}`,
          );
          message.nack();
        }
      })();
    });

    this.subscription.on('error', (err) => {
      this.logger?.error(
        `[${this.consumerName}] Subscription error on ${this.subscriptionName}: ${String(err)}`,
      );
    });

    this.logger?.info(
      `[${this.consumerName}] Listening on subscription: ${this.subscriptionName}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.subscription) {
      return;
    }
    this.isRunning = false;
    try {
      await this.subscription.close();
      this.logger?.info(
        `[${this.consumerName}] Stopped subscription: ${this.subscriptionName}`,
      );
    } catch (error) {
      this.logger?.error(
        `[${this.consumerName}] Error closing subscription ${this.subscriptionName}: ${String(error)}`,
      );
    }
  }

  protected abstract isValidPayload(payload: TPayload): boolean;
  protected abstract handlePayload(
    payload: TPayload,
    message: Message,
  ): Promise<void>;
}
