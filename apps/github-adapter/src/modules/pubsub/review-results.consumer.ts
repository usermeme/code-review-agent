import { FastifyBaseLogger } from 'fastify';
import { GithubService } from '../github/github.service.js';
import { ReviewResultPayload } from 'shared-types';
import { AbstractPubSubConsumer, BaseConsumerDependencies } from 'pubsub';

export interface ReviewResultsConsumerDependencies extends BaseConsumerDependencies {
  githubService: GithubService;
  logger?: FastifyBaseLogger;
}

export class ReviewResultsConsumer extends AbstractPubSubConsumer<ReviewResultPayload> {
  protected readonly consumerName = 'ReviewResultsConsumer';
  private githubService: GithubService;

  constructor(deps: ReviewResultsConsumerDependencies) {
    super(deps);
    this.githubService = deps.githubService;
  }

  protected isValidPayload(payload: ReviewResultPayload): boolean {
    return Boolean(
      payload.owner && payload.repo && typeof payload.prNumber === 'number',
    );
  }

  protected async handlePayload(payload: ReviewResultPayload): Promise<void> {
    await this.githubService.postReview({
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.prNumber,
      summary: payload.summary || '',
      ticketCoverage: payload.ticketCoverage,
      comments: payload.comments || [],
    });
  }
}
