import type { EndpointPayloadRecord } from '@code-review-agent/endpoints';
import { FastifyPluginAsync } from 'fastify';

import { ContextRepository } from '../database/repositories/context.repository.js';

export interface ContextRoutesOptions {
  contextRepository: ContextRepository;
}

export const contextRoutes: FastifyPluginAsync<ContextRoutesOptions> = async (
  fastify,
  options,
) => {
  const { contextRepository } = options;

  fastify.get<{
    Params: NonNullable<
      EndpointPayloadRecord['/api/v1/context/:prKey']['Params']
    >;
  }>('/:prKey', async (request, reply) => {
    const { prKey } = request.params;
    const context = await contextRepository.getContext(prKey);

    if (!context) {
      return reply.code(404).send({ error: 'Context not found' });
    }

    return context;
  });
};
