import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { GithubService } from './modules/github/github.service.js';
import { webhooksModule } from './modules/webhooks/webhooks.module.js';
import { healthModule } from './modules/health/health.module.js';
import { gatewayRpcRoutes } from './rpc/gateway.routes.js';
import { createClient, Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { envService as defaultEnvService, GatewayEnvService } from './env.js';
import { CoreService, createAuthClientInterceptor } from 'contracts';

export interface BuildServerOptions {
  coreClient?: Client<typeof CoreService>;
  githubService?: GithubService;
  fastifyOptions?: FastifyServerOptions;
  envService?: GatewayEnvService;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });
  const env = options.envService ?? defaultEnvService;

  await server.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  let coreClient = options.coreClient;
  if (!coreClient) {
    const coreUrl = env.get('CORE_URL');
    const transport = createConnectTransport({
      baseUrl: coreUrl,
      httpVersion: '1.1',
      interceptors: [createAuthClientInterceptor({})],
    });
    coreClient = createClient(CoreService, transport);
  }

  const githubService =
    options.githubService ?? new GithubService({ coreClient, envService: env });

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
  });

  return server;
}
