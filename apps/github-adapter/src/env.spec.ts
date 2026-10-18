import { EnvService } from '@code-review-agent/env';
import { describe, expect, it } from 'vitest';

import { adapterEnvSchema, normalizePrivateKey } from './env.js';

const SAMPLE_PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

describe('adapterEnvSchema & normalizePrivateKey', () => {
  it('accepts a multi-line PEM private key as-is', () => {
    const env = new EnvService(adapterEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY: SAMPLE_PEM,
    });

    expect(env.get('GITHUB_APP_ID')).toBe('123456');
    expect(env.get('GITHUB_APP_PRIVATE_KEY')).toBe(SAMPLE_PEM);
    expect(env.get('PORT')).toBe(8080);
  });

  it('unescapes literal \\n sequences in PEM private keys', () => {
    const escapedPem = SAMPLE_PEM.replace(/\n/g, '\\n');

    expect(normalizePrivateKey(escapedPem)).toBe(SAMPLE_PEM);
  });

  it('decodes base64-encoded PEM private keys', () => {
    const base64Pem = Buffer.from(SAMPLE_PEM, 'utf8').toString('base64');

    const env = new EnvService(adapterEnvSchema, {
      HOST: '0.0.0.0',
      PORT: '8080',
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY: base64Pem,
    });

    expect(env.get('GITHUB_APP_PRIVATE_KEY')).toBe(SAMPLE_PEM);
  });

  it('throws when GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is missing', () => {
    expect(
      () =>
        new EnvService(adapterEnvSchema, {
          HOST: '0.0.0.0',
          PORT: '8080',
        }),
    ).toThrow(/Environment validation failed/);
  });

  it('throws when GITHUB_APP_PRIVATE_KEY is not a valid PEM key', () => {
    expect(
      () =>
        new EnvService(adapterEnvSchema, {
          HOST: '0.0.0.0',
          PORT: '8080',
          GITHUB_APP_ID: '123456',
          GITHUB_APP_PRIVATE_KEY: 'not-a-pem-key',
        }),
    ).toThrow(/GITHUB_APP_PRIVATE_KEY must be a valid PEM private key/);
  });
});
