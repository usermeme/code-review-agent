import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { healthRoutes } from './health.routes.js';

describe('healthRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    await app.ready();
  });

  it('returns 200 on GET /healthz (Cloud Run / Pub/Sub liveness probe)', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('core');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.timestamp).toBe('string');
  });
});
