import { FastifyPluginAsync } from 'fastify';
import { GithubService } from '../github/github.service.js';

export interface ProviderRoutesOptions {
  githubService: GithubService;
}

export const providerRoutes: FastifyPluginAsync<ProviderRoutesOptions> = async (
  fastify,
  options,
) => {
  const { githubService } = options;

  // 1. Fetch PR Diff & Changed Files
  fastify.get<{
    Params: { owner: string; repo: string; number: string };
  }>('/repos/:owner/:repo/pulls/:number/diff', async (request, reply) => {
    const { owner, repo, number } = request.params;
    const prNumber = parseInt(number, 10);
    if (isNaN(prNumber)) {
      return reply.code(400).send({ error: 'Invalid PR number' });
    }

    try {
      const result = await githubService.getPRDiff(owner, repo, prNumber);
      return result;
    } catch (error) {
      fastify.log.error(`Failed to fetch PR diff: ${error}`);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 2. Search Code in Repository
  fastify.get<{
    Params: { owner: string; repo: string };
    Querystring: { q?: string };
  }>('/repos/:owner/:repo/search', async (request, reply) => {
    const { owner, repo } = request.params;
    const query = request.query.q;
    if (!query) {
      return reply.code(400).send({ error: 'Query parameter "q" is required' });
    }

    try {
      const result = await githubService.searchCode(owner, repo, query);
      return result;
    } catch (error) {
      fastify.log.error(`Failed to search code: ${error}`);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 3. Get File Content
  fastify.get<{
    Params: { owner: string; repo: string; '*': string };
    Querystring: { ref?: string };
  }>('/repos/:owner/:repo/files/*', async (request, reply) => {
    const { owner, repo } = request.params;
    const path = request.params['*'];
    const ref = request.query.ref;

    if (!path) {
      return reply.code(400).send({ error: 'File path is required' });
    }

    try {
      const result = await githubService.getFileContent(owner, repo, path, ref);
      return result;
    } catch (error) {
      fastify.log.error(`Failed to get file content: ${error}`);
      return reply.code(500).send({ error: String(error) });
    }
  });
};
