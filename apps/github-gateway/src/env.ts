import { z } from 'zod';
import { EnvService } from 'env';

export const gatewayEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  CORE_URL: z.string().min(1),
  GIT_ADAPTER_WEBHOOK_SECRET: z.string().min(1),
  GIT_ADAPTER_TOKEN: z.string().min(1),
  PUBSUB_SECRET_TOKEN: z.string().optional(),
});

export type GatewayEnvSchema = typeof gatewayEnvSchema;
export type GatewayEnvService = EnvService<GatewayEnvSchema>;

export const envService: GatewayEnvService = new EnvService(gatewayEnvSchema);
