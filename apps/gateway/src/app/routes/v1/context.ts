import { FastifyInstance, FastifyRequest } from 'fastify';
import { dbService } from '../../../services/db.service.js';

interface ContextBody {
  repo: string;
  headSha?: string;
  sections: Record<string, string>;
}

export default async function (fastify: FastifyInstance) {
  fastify.post('/context', async function (request: FastifyRequest<{ Body: ContextBody }>, reply) {
    const body = request.body;
    
    if (!body.repo || !body.sections) {
      return reply.code(400).send({ error: 'Missing required fields: repo, sections' });
    }

    try {
      const saved = await dbService.saveContext(body.repo, {
        headSha: body.headSha,
        sections: body.sections,
      });
      return { success: true, updatedAt: saved.updatedAt };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to save context' });
    }
  });

  fastify.get('/context', async function (request: FastifyRequest<{ Querystring: { repo: string } }>, reply) {
    const { repo } = request.query;
    if (!repo) {
      return reply.code(400).send({ error: 'Missing repo parameter' });
    }

    const data = await dbService.getContext(repo);
    if (!data) {
      return reply.code(404).send({ error: 'Context not found' });
    }
    return data;
  });
}
