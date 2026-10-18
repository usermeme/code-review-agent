import { Readable } from 'node:stream';

import type { EndpointPayloadRecord } from '@code-review-agent/endpoints';
import { FastifyPluginAsync } from 'fastify';

import { GithubService } from '../github/github.service.js';

export interface ProviderRoutesOptions {
  githubService: GithubService;
}

function isWebReadableStream(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'getReader' in body &&
    typeof (body as { getReader?: unknown }).getReader === 'function'
  );
}

function toNodeReadableStream(body: unknown): NodeJS.ReadableStream {
  return isWebReadableStream(body)
    ? Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
    : (body as NodeJS.ReadableStream);
}

function resolveCommitSha(headers: Headers, ref?: string): string {
  return headers.get('x-github-commit-sha') || ref || 'main';
}

export const providerRoutes: FastifyPluginAsync<ProviderRoutesOptions> = async (
  fastify,
  options,
) => {
  const { githubService } = options;

  // 1. Fetch PR Diff & Changed Files
  fastify.get<{
    Params: NonNullable<
      EndpointPayloadRecord['/api/v1/repos/:owner/:repo/pulls/:number/diff']['Params']
    >;
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

  // 2. Fetch PR Files with Content
  fastify.get<{
    Params: NonNullable<
      EndpointPayloadRecord['/api/v1/repos/:owner/:repo/pulls/:number/files']['Params']
    >;
  }>('/repos/:owner/:repo/pulls/:number/files', async (request, reply) => {
    const { owner, repo, number } = request.params;
    const prNumber = parseInt(number, 10);
    if (isNaN(prNumber)) {
      return reply.code(400).send({ error: 'Invalid PR number' });
    }

    try {
      const result = await githubService.getPRFiles(owner, repo, prNumber);
      return result;
    } catch (error) {
      fastify.log.error(`Failed to fetch PR files: ${error}`);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 3. Search Code in Repository
  fastify.get<{
    Params: NonNullable<
      EndpointPayloadRecord['/api/v1/repos/:owner/:repo/search']['Params']
    >;
    Querystring: NonNullable<
      EndpointPayloadRecord['/api/v1/repos/:owner/:repo/search']['Query']
    >;
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

  // 4. Download Repository Tarball Archive
  fastify.get<{
    Params: NonNullable<
      EndpointPayloadRecord['/api/v1/repos/:owner/:repo/tarball']['Params']
    >;
    Querystring: NonNullable<
      EndpointPayloadRecord['/api/v1/repos/:owner/:repo/tarball']['Query']
    >;
  }>('/repos/:owner/:repo/tarball', async (request, reply) => {
    const { owner, repo } = request.params;
    const ref = request.query.ref;

    try {
      const upstream = await githubService.getRepoTarball(owner, repo, ref);
      if (!upstream.body) {
        return reply.code(500).send({ error: 'Empty tarball response body' });
      }

      reply.header('content-type', 'application/x-gzip');
      reply.header('x-commit-sha', resolveCommitSha(upstream.headers, ref));

      return reply.send(toNodeReadableStream(upstream.body));
    } catch (error) {
      fastify.log.error(`Failed to fetch repo tarball: ${error}`);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 5. Get File Content
  fastify.get<{
    Params: NonNullable<
      EndpointPayloadRecord['/api/v1/repos/:owner/:repo/files/:path']['Params']
    >;
    Querystring: NonNullable<
      EndpointPayloadRecord['/api/v1/repos/:owner/:repo/files/:path']['Query']
    >;
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
