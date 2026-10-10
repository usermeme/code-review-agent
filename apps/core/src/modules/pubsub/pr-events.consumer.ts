import { FastifyBaseLogger } from 'fastify';
import { EventOrchestratorService } from '../../services/event-orchestrator.service.js';
import { PREventPayload } from 'shared-types';
import { AbstractPubSubConsumer, BaseConsumerDependencies } from 'pubsub';

export interface PrEventsConsumerDependencies extends BaseConsumerDependencies {
  orchestrator: EventOrchestratorService;
  logger?: FastifyBaseLogger;
}

export class PrEventsConsumer extends AbstractPubSubConsumer<PREventPayload> {
  protected readonly consumerName = 'PrEventsConsumer';
  private orchestrator: EventOrchestratorService;

  constructor(deps: PrEventsConsumerDependencies) {
    super(deps);
    this.orchestrator = deps.orchestrator;
  }

  protected isValidPayload(payload: PREventPayload): boolean {
    return Boolean(
      payload.prMeta && payload.prMeta.owner && payload.prMeta.repo,
    );
  }

  protected async handlePayload(payload: PREventPayload): Promise<void> {
    await this.orchestrator.ingestPREvent(
      payload,
      this.logger as FastifyBaseLogger,
    );
  }
}
