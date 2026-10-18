import { EnvService } from '@code-review-agent/env';
import { z } from 'zod';

/**
 * Normalizes a GitHub App private key from Secret Manager / env injection:
 * - multi-line PEM passed through as-is
 * - literal `\n` sequences unescaped into newlines
 * - base64-encoded PEM decoded to UTF-8
 */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  const unescaped = trimmed.replace(/\\n/g, '\n');
  if (unescaped.startsWith('-----BEGIN ')) {
    return unescaped;
  }
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
  if (decoded.startsWith('-----BEGIN ')) {
    return decoded.replace(/\\n/g, '\n');
  }
  return unescaped;
}

export function isValidPemPrivateKey(key: string): boolean {
  return key.startsWith('-----BEGIN ') && key.includes('-----END ');
}

export const adapterEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .min(1)
    .transform(normalizePrivateKey)
    .refine(isValidPemPrivateKey, {
      message:
        'GITHUB_APP_PRIVATE_KEY must be a valid PEM private key (raw PEM, \\n-escaped PEM, or base64-encoded PEM)',
    }),
});

type AdapterEnvSchema = typeof adapterEnvSchema;
export type AdapterEnvService = EnvService<AdapterEnvSchema>;

export const envService: AdapterEnvService = new EnvService(adapterEnvSchema);
