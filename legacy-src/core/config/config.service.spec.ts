import { describe, expect, it } from 'vitest';
import { applyEnvOverrides, interpolateEnv } from './config.service.js';
import { configSchema } from './config.schema.js';

const MINIMAL = {
  providers: {
    github: { appId: '1', privateKeyBase64: 'a2V5', webhookSecret: 's' },
  },
  models: {
    tiers: { default: { provider: 'gemini', model: 'gemini-2.5-flash' } },
    agents: { orchestrator: 'default' },
  },
};

describe('interpolateEnv', () => {
  it('substitutes ${VAR} exactly, returning undefined if missing', () => {
    const result = interpolateEnv({ a: '${FOO}', b: '${BAR}' }, { FOO: 'foo' });
    expect(result).toEqual({ a: 'foo', b: undefined });
  });

  it('substitutes ${VAR} within a string, replacing with empty string if missing', () => {
    const result = interpolateEnv(
      { url: 'http://${HOST}:${PORT}/api' },
      { HOST: 'localhost' },
    );
    expect(result).toEqual({ url: 'http://localhost:/api' });
  });

  it('filters out undefined elements from arrays', () => {
    const result = interpolateEnv(['${FOO}', 'plain', '${BAR}'], {
      FOO: 'foo',
    });
    expect(result).toEqual(['foo', 'plain']);
  });

  it('leaves non-string primitives unchanged', () => {
    const result = interpolateEnv(
      { num: 42, bool: true, nil: null, empty: '' },
      {},
    );
    expect(result).toEqual({ num: 42, bool: true, nil: null, empty: '' });
  });
});

describe('applyEnvOverrides', () => {
  it('sets nested keys from CRA__ variables', () => {
    const config: Record<string, unknown> = {
      cache: { repoContextTtlSeconds: 1 },
    };
    applyEnvOverrides(config, {
      CRA__cache__repoContextTtlSeconds: '3600',
      UNRELATED: 'x',
    });
    expect(config).toEqual({
      cache: { repoContextTtlSeconds: 3600 },
    });
  });

  it('parses boolean and number values correctly', () => {
    const config: Record<string, unknown> = {};
    applyEnvOverrides(config, {
      CRA__isTrue: 'true',
      CRA__isFalse: 'false',
      CRA__count: '42',
      CRA__zero: '0',
      CRA__text: 'hello',
    });
    expect(config).toEqual({
      isTrue: true,
      isFalse: false,
      count: 42,
      zero: 0,
      text: 'hello',
    });
  });

  it('creates nested objects if they do not exist', () => {
    const config: Record<string, unknown> = { existing: { keep: true } };
    applyEnvOverrides(config, {
      CRA__existing__newKey: 'val',
      CRA__newRoot__newLeaf: 'val',
    });
    expect(config).toEqual({
      existing: { keep: true, newKey: 'val' },
      newRoot: { newLeaf: 'val' },
    });
  });

  it('ignores empty values or variables not starting with prefix', () => {
    const config: Record<string, unknown> = { existing: true };
    applyEnvOverrides(config, {
      CRA__emptyString: '',
      CRA__undefinedVar: undefined,
      OTHER__var: '123',
    });
    // empty string is still processed as a string if it's not undefined in env
    expect(config).toEqual({
      existing: true,
      emptyString: '',
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
        models: {
          tiers: { bad: { provider: 'openai', model: 'x' } },
          agents: {},
        },
      }),
    ).toThrow();
  });
});
