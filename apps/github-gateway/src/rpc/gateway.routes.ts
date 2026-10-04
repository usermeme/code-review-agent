import { FastifyPluginAsync } from 'fastify';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import { ConnectRouter } from '@connectrpc/connect';
import { GatewayService, createAuthInterceptor } from 'contracts';
import { GithubService } from '../modules/github/github.service.js';

export interface GatewayRpcPluginOptions {
  githubService: GithubService;
}

export const gatewayRpcRoutes: FastifyPluginAsync<GatewayRpcPluginOptions> = async (
  fastify,
  options,
) => {
  const { githubService } = options;

  await fastify.register(fastifyConnectPlugin, {
    routes(router: ConnectRouter) {
      router.service(GatewayService, {
        async postReview(req) {
          const result = await githubService.postReview({
            owner: req.owner,
            repo: req.repo,
            prNumber: req.prNumber,
            summary: req.summary,
            ticketCoverage: req.ticketCoverage,
            comments: (req.comments || []).map((c) => ({
              path: c.path,
              position: c.position,
              body: c.body,
            })),
          });

          return {
            $typeName: 'gateway.v1.PostReviewResponse',
            success: result.success,
            message: result.message,
            reviewId: result.reviewId || '',
          };
        },
      });
    },
    interceptors: [createAuthInterceptor({})],
  });
};
