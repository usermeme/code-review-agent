import { z } from 'zod';
import { EnvService } from 'env';

export const gatewayEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  PR_EVENTS_TOPIC: z.string().min(1).default('pr-events'),
  REVIEW_RESULTS_SUBSCRIPTION: z.string().min(1).default('review-results-sub'),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
});

export type GatewayEnvSchema = typeof gatewayEnvSchema;
export type GatewayEnvService = EnvService<GatewayEnvSchema>;

export const envService: GatewayEnvService = new EnvService(gatewayEnvSchema);
