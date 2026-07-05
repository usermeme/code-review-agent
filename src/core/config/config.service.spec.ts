import { describe, expect, it } from 'vitest';
import { applyEnvOverrides, interpolateEnv } from './config.service.js';
import { configSchema } from './config.schema.js';

const MINIMAL = {
  providers: { github: { appId: '1', privateKeyBase64: 'a2V5', webhookSecret: 's' } },
  models: {
    tiers: { default: { provider: 'gemini', model: 'gemini-2.5-flash' } },
    agents: { orchestrator: 'default' },
  },
};

describe('interpolateEnv', () => {
  it('substitutes ${VAR} recursively, missing vars become undefined (or filtered in arrays)', () => {
    const result = interpolateEnv({ a: '${FOO}', b: '${BAR}', nested: ['${BAR}', 'plain'] }, {
      FOO: 'foo',
    });
    expect(result).toEqual({ a: 'foo', b: undefined, nested: ['plain'] });
  });
});

describe('applyEnvOverrides', () => {
  it('sets nested keys from CRA__ variables with type coercion', () => {
    const config: Record<string, unknown> = { cache: { repoContextTtlSeconds: 1 } };
    applyEnvOverrides(config, {
      CRA__cache__repoContextTtlSeconds: '3600',
      CRA__triggers__onOpened: 'false',
      UNRELATED: 'x',
    });
    expect(config).toEqual({
      cache: { repoContextTtlSeconds: 3600 },
      triggers: { onOpened: false },
    });
  });
});

describe('configSchema', () => {
  it('fills defaults for optional groups', () => {
    const cfg = configSchema.parse(MINIMAL);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.cache.repoContextTtlSeconds).toBe(604800);
    expect(cfg.triggers.reviewCommand).toBe('/review');
    expect(cfg.tickets.jira.enabled).toBe(false);
  });

  it('rejects unknown tier shapes', () => {
    expect(() =>
      configSchema.parse({
        ...MINIMAL,
        models: { tiers: { bad: { provider: 'openai', model: 'x' } }, agents: {} },
      }),
    ).toThrow();
  });
});
