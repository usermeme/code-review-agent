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
      EndpointPayloadRecord['/api/v1/context/:repoKey']['Params']
    >;
  }>('/:repoKey', async (request, reply) => {
    const context = await contextRepository.get(request.params.repoKey);

    if (!context) {
      return reply.code(404).send({ error: 'Context not found' });
    }

    return context;
  });
};
