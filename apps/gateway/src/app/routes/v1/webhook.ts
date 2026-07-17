import { FastifyInstance, FastifyRequest } from 'fastify';
import { dbService } from '../../../services/db.service.js';
import { pubSubService } from '../../../services/pubsub.service.js';

interface WebhookBody {
  action?: string;
  pull_request?: {
    number: number;
    base: { ref: string };
  };
  repository?: {
    full_name: string;
    clone_url: string;
    default_branch: string;
  };
  ref?: string;
}

export default async function (fastify: FastifyInstance) {
  fastify.post('/webhook', async function (request: FastifyRequest<{ Body: WebhookBody }>, reply) {
    const event = request.headers['x-github-event'] || request.headers['x-event-type'];
    const payload = request.body;
    
    if (!payload.repository) {
      return reply.code(400).send({ error: 'Missing repository in payload' });
    }

    const repo = payload.repository.full_name;

    try {
      if (event === 'pull_request' && payload.action && ['opened', 'synchronize'].includes(payload.action)) {
        // Trigger Code Reviewer
        if (!payload.pull_request) {
          return reply.code(400).send({ error: 'Missing pull_request in payload' });
        }

        const prNumber = payload.pull_request.number;
        const contextObj = await dbService.getContext(repo);
        
        await pubSubService.publish('agent-code-reviewer-topic', {
          repo,
          prNumber,
          contextData: contextObj ? contextObj.sections : {},
        });

        fastify.log.info(`Triggered code-reviewer for ${repo}#${prNumber}`);
        return { success: true, triggered: 'code-reviewer' };
      } 
      else if (event === 'push') {
        // Trigger Context Builder if push to default branch
        const defaultBranchRef = `refs/heads/${payload.repository.default_branch}`;
        if (payload.ref === defaultBranchRef) {
          await pubSubService.publish('agent-context-builder-topic', {
            repo,
            ref: payload.repository.default_branch,
            cloneUrl: payload.repository.clone_url,
          });

          fastify.log.info(`Triggered context-builder for ${repo} on branch ${payload.repository.default_branch}`);
          return { success: true, triggered: 'context-builder' };
        }
      }

      return { success: true, message: 'Event received but ignored' };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal Server Error processing webhook' });
    }
  });
}
