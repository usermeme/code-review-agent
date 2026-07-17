import { Webhooks } from '@octokit/webhooks';
import { PubSub } from '@google-cloud/pubsub';
import { FastifyBaseLogger } from 'fastify';
import { getSecret } from '../../../services/secrets.service.js';
import { GitAdapter } from '../interfaces/git-adapter.interface.js';
import { ProcessedWebhookResult } from '../interfaces/webhooks.interface.js';

export class GithubAdapter implements GitAdapter {
  private webhooks?: Webhooks;
  private pubsub: PubSub;

  constructor() {
    this.pubsub = new PubSub();
  }

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

  canHandle(headers: Record<string, string | string[] | undefined>): boolean {
    return headers['x-github-event'] !== undefined;
  }

  async verifySignature(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean> {
    if (!this.webhooks) {
      throw new Error('GithubAdapter not initialized');
    }

    const signature = headers['x-hub-signature-256'];
    if (!signature || typeof signature !== 'string') {
      return false;
    }

    return this.webhooks.verify(rawBody, signature);
  }

  async processEvent(headers: Record<string, string | string[] | undefined>, payload: any, logger: FastifyBaseLogger): Promise<ProcessedWebhookResult> {
    const event = headers['x-github-event'];

    if (event === 'pull_request') {
      const action = payload.action;
      if (action === 'opened' || action === 'synchronize') {
        logger.info(`Received GitHub PR event: ${action} for ${payload.pull_request?.html_url}`);
        
        await this.publishContextBuild({
          provider: 'github',
          owner: payload.repository?.owner?.login,
          repo: payload.repository?.name,
          prNumber: payload.pull_request?.number,
          action,
        });
        
        return { status: 'Context build triggered for GitHub' };
      }
    } else if (event === 'issue_comment') {
      const action = payload.action;
      if (action === 'created' && payload.issue?.pull_request) {
        const commentBody = payload.comment?.body || '';
        if (commentBody.includes('/review')) {
          logger.info(`Received GitHub manual /review trigger on ${payload.issue?.html_url}`);
          
          await this.publishContextBuild({
            provider: 'github',
            owner: payload.repository?.owner?.login,
            repo: payload.repository?.name,
            prNumber: payload.issue?.number,
            action: 'manual_trigger',
          });
          
          return { status: 'Manual review triggered for GitHub' };
        }
      }
    }

    return { status: 'Ignored GitHub event' };
  }

  private async publishContextBuild(data: any): Promise<void> {
    const topicName = process.env.BUILD_CONTEXT_TOPIC || 'build-context-topic';
    await this.pubsub.topic(topicName).publishMessage({
      json: data
    });
  }
}
