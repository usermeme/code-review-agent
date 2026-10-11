import { z } from 'zod';
import { EnvService } from 'env';

export const adapterEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GITHUB_TOKEN: z.string().min(1),
  REVIEW_RESULTS_SUBSCRIPTION: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
});

export type AdapterEnvSchema = typeof adapterEnvSchema;
export type AdapterEnvService = EnvService<AdapterEnvSchema>;

export const envService: AdapterEnvService = new EnvService(adapterEnvSchema);
