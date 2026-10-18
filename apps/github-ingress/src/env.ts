import { EnvService } from '@code-review-agent/env';
import { z } from 'zod';

export const ingressEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.string().transform(Number),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  PR_EVENTS_TOPIC: z.string().min(1).default('pr-events'),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
});

type IngressEnvSchema = typeof ingressEnvSchema;
export type IngressEnvService = EnvService<IngressEnvSchema>;

export const envService: IngressEnvService = new EnvService(ingressEnvSchema);
