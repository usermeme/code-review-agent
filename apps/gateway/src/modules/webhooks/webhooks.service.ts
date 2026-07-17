import { Webhooks } from '@octokit/webhooks';
import { PubSub } from '@google-cloud/pubsub';
import { getSecret } from '../../services/secrets.service.js';
import { ProcessedWebhookResult } from './interfaces/webhooks.interface.js';
import { FastifyBaseLogger } from 'fastify';

export class WebhooksService {
  private webhooks?: Webhooks;
  private pubsub: PubSub;

  constructor() {
    this.pubsub = new PubSub();
  }

  /**
   * Initializes the GitHub Webhooks SDK with the secret from GCP.
   */
  async init(logger: FastifyBaseLogger): Promise<void> {
    const secretName = process.env.GITHUB_WEBHOOK_SECRET_ID || 'dummy-secret-for-local-dev';
    let githubSecret = 'dummy';
    
    if (secretName !== 'dummy-secret-for-local-dev') {
      try {
        githubSecret = await getSecret(secretName);
      } catch (e) {
        logger.error(`Failed to fetch github secret: ${e}`);
      }
    }

    this.webhooks = new Webhooks({ secret: githubSecret });
  }

  /**
   * Verifies the cryptographic signature of the webhook payload.
   */
  async verifySignature(rawBody: string, signature: string): Promise<boolean> {
    if (!this.webhooks) {
      throw new Error('WebhooksService not initialized');
    }
    return this.webhooks.verify(rawBody, signature);
  }

  /**
   * Processes the parsed payload and publishes to Pub/Sub if needed.
   */
  async processEvent(event: string, payload: any, logger: FastifyBaseLogger): Promise<ProcessedWebhookResult> {
    if (event === 'pull_request') {
      const action = payload.action;
      if (action === 'opened' || action === 'synchronize') {
        logger.info(`Received PR event: ${action} for ${payload.pull_request.html_url}`);
        
        await this.publishContextBuild({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          prNumber: payload.pull_request.number,
          action,
        });
        
        return { status: 'Context build triggered' };
      }
    } else if (event === 'issue_comment') {
      const action = payload.action;
      if (action === 'created' && payload.issue.pull_request) {
        const commentBody = payload.comment.body;
        if (commentBody.includes('/review')) {
          logger.info(`Received manual /review trigger on ${payload.issue.html_url}`);
          
          await this.publishContextBuild({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            prNumber: payload.issue.number,
            action: 'manual_trigger',
          });
          
          return { status: 'Manual review triggered' };
        }
      }
    }

    return { status: 'Ignored event' };
  }

  private async publishContextBuild(data: any): Promise<void> {
    const topicName = process.env.BUILD_CONTEXT_TOPIC || 'build-context-topic';
    await this.pubsub.topic(topicName).publishMessage({
      json: data
    });
  }
}
