import { defineConfig } from 'vitest/config';

import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      env: path.resolve(__dirname, 'libs/env/src/index.ts'),
      'shared-types': path.resolve(__dirname, 'libs/shared-types/src/index.ts'),
      contracts: path.resolve(__dirname, 'libs/contracts/src/index.ts'),
    },
  },
  test: {
    include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts'],
    env: {
      HOST: '0.0.0.0',
      PORT: '8080',
      CORE_URL: 'http://localhost:8080',
      GATEWAY_URL: 'http://localhost:8080',
      GIT_ADAPTER_WEBHOOK_SECRET: 'test-secret',
      GIT_ADAPTER_TOKEN: 'test-token',
      PUBSUB_SECRET_TOKEN: 'test-token',
      BUILD_CONTEXT_TOPIC: 'build-context-topic',
      REVIEW_CODE_TOPIC: 'review-code-topic',
      CONTEXT_READY_TOPIC: 'context-ready-topic',
      REVIEW_RESULT_TOPIC: 'review-result-topic',
      REVIEW_MODEL: 'gemini-2.5-pro',
    },
  },
});
