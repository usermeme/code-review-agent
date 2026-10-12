import { FastifyPluginAsync } from 'fastify';

import { GithubService } from '../github/github.service.js';
import { reviewResultsPushRoutes } from './review-results-push.routes.js';

export interface PubSubModuleOptions {
  githubService: GithubService;
}

export const pubsubModule: FastifyPluginAsync<PubSubModuleOptions> = async (
  fastify,
  options,
) => {
  const { githubService } = options;
  await fastify.register(reviewResultsPushRoutes, { githubService });
};
