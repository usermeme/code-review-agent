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
  },
});
