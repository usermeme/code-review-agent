import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Env } from './env.js';

describe('Env', () => {
  it('successfully parses valid environment variables and retrieves them via get', () => {
    const schema = z.object({
      PORT: z.string().transform(Number),
      HOST: z.string(),
      NODE_ENV: z.enum(['development', 'production', 'test']),
      IS_ENABLED: z.string().transform((v) => v === 'true'),
    });

    const env = new Env(schema, {
      PORT: '8080',
      HOST: '0.0.0.0',
      NODE_ENV: 'test',
      IS_ENABLED: 'true',
    });

    expect(env.get('PORT')).toBe(8080);
    expect(env.get('HOST')).toBe('0.0.0.0');
    expect(env.get('NODE_ENV')).toBe('test');
    expect(env.get('IS_ENABLED')).toBe(true);
  });

  it('throws an error in constructor when a required variable is missing', () => {
    const schema = z.object({
      REQUIRED_KEY: z.string(),
      ANOTHER_KEY: z.string(),
    });

    expect(() => {
      new Env(schema, {
        REQUIRED_KEY: 'present',
      });
    }).toThrowError(/Environment validation failed:\s+- ANOTHER_KEY:/);
  });

  it('throws an error in constructor when a variable fails schema validation', () => {
    const schema = z.object({
      SERVICE_URL: z.string().url(),
    });

    expect(() => {
      new Env(schema, {
        SERVICE_URL: 'not-a-valid-url',
      });
    }).toThrowError(/Environment validation failed:\s+- SERVICE_URL:/);
  });

  it('defaults to process.env if no source is provided', () => {
    process.env['TEST_DEFAULT_ENV_VAR'] = 'hello-from-process-env';

    const schema = z.object({
      TEST_DEFAULT_ENV_VAR: z.string(),
    });

    const env = new Env(schema);
    expect(env.get('TEST_DEFAULT_ENV_VAR')).toBe('hello-from-process-env');

    delete process.env['TEST_DEFAULT_ENV_VAR'];
  });
});
