import { FastifyPluginAsync } from 'fastify';
import { ContextRepository } from '../database/repositories/context.repository.js';

export interface ContextModuleOptions {
  contextRepository: ContextRepository;
}

export const contextModule: FastifyPluginAsync<ContextModuleOptions> = async (
  fastify,
  options,
) => {
  const { contextRepository } = options;

  fastify.get('/context/:prKey', async (request, reply) => {
    const { prKey } = request.params as { prKey: string };

    const context = await contextRepository.getContext(prKey);

    if (!context) {
      return reply.code(404).send({ error: 'Context not found' });
    }

    return context;
  });
};
