import { FastifyPluginAsync } from 'fastify';
import { Webhooks } from '@octokit/webhooks';
import { getSecret } from '../../services/secrets.service.js';
import { PubSub } from '@google-cloud/pubsub';

const pubsub = new PubSub();

// Extend the FastifyRequest interface to include rawBody
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export const webhooksModule: FastifyPluginAsync = async (fastify) => {
  // Fetch secret dynamically. In production, provide the full Secret Manager resource name.
  // In development, we can fallback to a dummy secret if it's not set.
  const secretName = process.env.GITHUB_WEBHOOK_SECRET_ID || 'dummy-secret-for-local-dev';
  let githubSecret = 'dummy';
  
  if (secretName !== 'dummy-secret-for-local-dev') {
    try {
      githubSecret = await getSecret(secretName);
    } catch (e) {
      fastify.log.error(`Failed to fetch github secret: ${e}`);
    }
  }

  const webhooks = new Webhooks({ secret: githubSecret });

  fastify.post('/webhook', { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string;
    const event = request.headers['x-github-event'] as string;
    const id = request.headers['x-github-delivery'] as string;

    if (!signature || !event || !id || !request.rawBody) {
      return reply.code(400).send({ error: 'Missing GitHub webhook headers or body' });
    }

    try {
      // Verify Cryptographic Signature
      await webhooks.verify(request.rawBody, signature);
    } catch (error) {
      fastify.log.error(`Webhook Signature Verification Failed: ${error}`);
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    // Parse the JSON body now that it is verified
    const payload = request.body as any;

    if (event === 'pull_request') {
      const action = payload.action;
      if (action === 'opened' || action === 'synchronize') {
        fastify.log.info(`Received PR event: ${action} for ${payload.pull_request.html_url}`);
        
        // Publish to Pub/Sub to build context
        const topicName = process.env.BUILD_CONTEXT_TOPIC || 'build-context-topic';
        await pubsub.topic(topicName).publishMessage({
          json: {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            prNumber: payload.pull_request.number,
            action,
          }
        });
        
        return { status: 'Context build triggered' };
      }
    } else if (event === 'issue_comment') {
      const action = payload.action;
      if (action === 'created' && payload.issue.pull_request) {
        // If it's a comment on a PR, and we want to allow re-request via comment
        const commentBody = payload.comment.body;
        if (commentBody.includes('/review')) {
          fastify.log.info(`Received manual /review trigger on ${payload.issue.html_url}`);
          
          const topicName = process.env.BUILD_CONTEXT_TOPIC || 'build-context-topic';
          await pubsub.topic(topicName).publishMessage({
            json: {
              owner: payload.repository.owner.login,
              repo: payload.repository.name,
              prNumber: payload.issue.number,
              action: 'manual_trigger',
            }
          });
          
          return { status: 'Manual review triggered' };
        }
      }
    }

    return { status: 'Ignored event' };
  });
};
