import { EnvService } from 'env';
import { z } from 'zod';

export const adapterEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GITHUB_TOKEN: z.string().min(1),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
});

export type AdapterEnvSchema = typeof adapterEnvSchema;
export type AdapterEnvService = EnvService<AdapterEnvSchema>;

export const envService: AdapterEnvService = new EnvService(adapterEnvSchema);
