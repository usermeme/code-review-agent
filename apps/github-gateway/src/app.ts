import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { GithubService } from './modules/github/github.service.js';
import { webhooksModule } from './modules/webhooks/webhooks.module.js';
import { healthModule } from './modules/health/health.module.js';
import { gatewayRpcRoutes } from './rpc/gateway.routes.js';
import { createClient, Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import type { GatewayEnvService } from './env.js';
import { CoreService, createAuthClientInterceptor } from 'contracts';

export interface BuildServerOptions {
  envService: GatewayEnvService;
  coreClient?: Client<typeof CoreService>;
  githubService?: GithubService;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildServer(
  options: BuildServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  await server.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  let coreClient = options.coreClient;
  if (!coreClient) {
    const coreUrl = options.envService.get('CORE_URL');
    const transport = createConnectTransport({
      baseUrl: coreUrl,
      httpVersion: '1.1',
      interceptors: [
        createAuthClientInterceptor({
          token: options.envService.get('INTERNAL_AUTH_TOKEN'),
        }),
      ],
    });
    coreClient = createClient(CoreService, transport);
  }

  const githubService =
    options.githubService ??
    new GithubService({ coreClient, envService: options.envService });

  // 1. Health check module
  await server.register(healthModule);

  // 2. Webhook Ingress module
  await server.register(webhooksModule, {
    prefix: '/api/v1/webhooks',
    githubService,
  });

  // 3. ConnectRPC Egress module
  await server.register(gatewayRpcRoutes, {
    githubService,
    envService: options.envService,
  });

  return server;
}
