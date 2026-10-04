import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvService } from './env.service.js';

describe('EnvService', () => {
  it('successfully parses valid environment variables and retrieves them via get and getOrThrow', () => {
    const schema = z.object({
      PORT: z.string().transform(Number),
      HOST: z.string(),
      NODE_ENV: z.enum(['development', 'production', 'test']),
      IS_ENABLED: z.string().transform((v) => v === 'true'),
    });

    const envService = new EnvService(schema, {
      PORT: '8080',
      HOST: '0.0.0.0',
      NODE_ENV: 'test',
      IS_ENABLED: 'true',
    });

    expect(envService.get('PORT')).toBe(8080);
    expect(envService.get('HOST')).toBe('0.0.0.0');
    expect(envService.get('NODE_ENV')).toBe('test');
    expect(envService.get('IS_ENABLED')).toBe(true);
    expect(envService.getOrThrow('PORT')).toBe(8080);
  });

  it('throws an error in constructor when a required variable is missing', () => {
    const schema = z.object({
      REQUIRED_KEY: z.string(),
      ANOTHER_KEY: z.string(),
    });

    expect(() => {
      new EnvService(schema, {
        REQUIRED_KEY: 'present',
      });
    }).toThrowError(/Environment validation failed:\s+- ANOTHER_KEY:/);
  });

  it('throws an error in constructor when a variable fails schema validation', () => {
    const schema = z.object({
      SERVICE_URL: z.string().url(),
    });

    expect(() => {
      new EnvService(schema, {
        SERVICE_URL: 'not-a-valid-url',
      });
    }).toThrowError(/Environment validation failed:\s+- SERVICE_URL:/);
  });

  it('defaults to process.env if no source is provided', () => {
    process.env['TEST_DEFAULT_ENV_VAR'] = 'hello-from-process-env';

    const schema = z.object({
      TEST_DEFAULT_ENV_VAR: z.string(),
    });

    const envService = new EnvService(schema);
    expect(envService.get('TEST_DEFAULT_ENV_VAR')).toBe('hello-from-process-env');
    expect(envService.getOrThrow('TEST_DEFAULT_ENV_VAR')).toBe('hello-from-process-env');

    delete process.env['TEST_DEFAULT_ENV_VAR'];
  });

  it('throws when getOrThrow is called on an undefined optional variable', () => {
    const schema = z.object({
      OPTIONAL_KEY: z.string().optional(),
    });

    const envService = new EnvService(schema, {});
    expect(envService.get('OPTIONAL_KEY')).toBeUndefined();
    expect(() => envService.getOrThrow('OPTIONAL_KEY')).toThrowError(
      /Environment variable "OPTIONAL_KEY" is not defined\./,
    );
  });
});
