import { defineConfig } from 'vitest/config';

import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      env: path.resolve(__dirname, 'libs/env/src/index.ts'),
      'shared-types': path.resolve(__dirname, 'libs/shared-types/src/index.ts'),
      contracts: path.resolve(__dirname, 'libs/contracts/src/index.ts'),
      'agent-context-builder': path.resolve(
        __dirname,
        'libs/agent-context-builder/src/index.ts',
      ),
      'agent-code-reviewer': path.resolve(
        __dirname,
        'libs/agent-code-reviewer/src/index.ts',
      ),
    },
  },
  test: {
    include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts'],
    env: {
      HOST: '0.0.0.0',
      PORT: '8080',
      GITHUB_WEBHOOK_SECRET: 'test-secret',
      GITHUB_TOKEN: 'test-token',
      PR_EVENTS_TOPIC: 'pr-events',
      PR_EVENTS_SUBSCRIPTION: 'pr-events-sub',
      REVIEW_RESULTS_TOPIC: 'review-results',
      REVIEW_RESULTS_SUBSCRIPTION: 'review-results-sub',
      REVIEW_MODEL: 'gemini-2.5-pro',
    },
  },
});
