import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
} from 'fastify';
import { InMemoryRunner, type Runner } from '@google/adk';
import { createContextBuilderAgent } from './agent.js';
import type { ContextBuilderEnvService } from './env.js';

export interface BuildContextBuilderServerOptions {
  envService: ContextBuilderEnvService;
  runner?: Runner;
  fastifyOptions?: FastifyServerOptions;
}

interface PubSubPushBody {
  message: {
    data: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

function isPubSubPushBody(body: unknown): body is PubSubPushBody {
  if (typeof body !== 'object' || body === null || !('message' in body)) {
    return false;
  }
  const message = body.message;
  if (typeof message !== 'object' || message === null || !('data' in message)) {
    return false;
  }
  return typeof message.data === 'string';
}

export async function buildContextBuilderServer(
  options: BuildContextBuilderServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify(options.fastifyOptions ?? { logger: true });

  const runner =
    options.runner ??
    new InMemoryRunner({
      agent: createContextBuilderAgent(options.envService),
      appName: 'agent-context-builder',
    });

  // Healthcheck endpoints for Cloud Run & container orchestration
  server.get('/', async () => ({
    status: 'ok',
    service: 'agent-context-builder',
  }));
  server.get('/healthz', async () => ({
    status: 'ok',
    service: 'agent-context-builder',
  }));

  const handleIngress = async (
    request: FastifyRequest<{
      Body: PubSubPushBody | Record<string, unknown> | string;
    }>,
    reply: FastifyReply,
  ) => {
    const body = request.body;
    let messageText: string;

    if (isPubSubPushBody(body)) {
      // Google Cloud Pub/Sub push envelope
      messageText = Buffer.from(body.message.data, 'base64').toString('utf8');
    } else if (typeof body === 'string') {
      messageText = body;
    } else if (body && typeof body === 'object') {
      messageText = JSON.stringify(body);
    } else {
      return reply
        .code(400)
        .send({ error: 'Missing or invalid request payload' });
    }

    try {
      server.log.info(
        { messageLength: messageText.length },
        'Executing Context Builder Agent',
      );
      for await (const event of runner.runEphemeral({
        userId: 'pubsub-trigger',
        newMessage: {
          role: 'user',
          parts: [{ text: messageText }],
        },
      })) {
        server.log.debug({ event }, 'Agent runner event emitted');
      }
      return reply.code(200).send({ status: 'ok' });
    } catch (err: unknown) {
      const errorObj =
        err instanceof Error
          ? err
          : new Error(typeof err === 'string' ? err : 'Unknown error');
      server.log.error(errorObj, 'Context Builder Agent execution failed');
      return reply.code(500).send({
        error: 'Agent execution failed',
        details: errorObj.message,
      });
    }
  };

  server.post('/', handleIngress);
  server.post('/pubsub', handleIngress);

  return server;
}
