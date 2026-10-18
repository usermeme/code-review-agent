import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@code-review-agent/env': path.resolve(
        __dirname,
        'libs/env/src/index.ts',
      ),
      '@code-review-agent/shared-types': path.resolve(
        __dirname,
        'libs/shared-types/src/index.ts',
      ),
      '@code-review-agent/agent-context-builder': path.resolve(
        __dirname,
        'libs/agent-context-builder/src/index.ts',
      ),
      '@code-review-agent/agent-code-reviewer': path.resolve(
        __dirname,
        'libs/agent-code-reviewer/src/index.ts',
      ),
      '@code-review-agent/llm': path.resolve(
        __dirname,
        'libs/llm/src/index.ts',
      ),
      '@code-review-agent/pubsub': path.resolve(
        __dirname,
        'libs/pubsub/src/index.ts',
      ),
      '@code-review-agent/endpoints': path.resolve(
        __dirname,
        'libs/endpoints/src/index.ts',
      ),
      '@code-review-agent/enpoints': path.resolve(
        __dirname,
        'libs/endpoints/src/index.ts',
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
      REVIEW_RESULTS_TOPIC: 'review-results',
      REVIEW_MODEL: 'gemini-2.5-pro',
      GEMINI_API_KEY: 'test-gemini-key',
      GIT_ADAPTER_URL: 'http://adapter:8080',
    },
  },
});
