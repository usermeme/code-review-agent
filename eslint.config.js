import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      '.nx/',
      'tmp/',
      '.agents/',
      '.opencode/',
    ],
  },
  js.configs.recommended,
  {
    // Type-aware linting for the app code (tsconfig covers src only).
    files: ['apps/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Objects flow through prompt templates where `${obj}` is a real bug,
      // but numbers in templates are fine.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Fire-and-forget is deliberate in the webhook path; require the `void` marker.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: true },
      ],
    },
  },
  {
    // Tests and tool configs: recommended rules without type information —
    // they sit outside the build tsconfig, and fixtures legitimately bend types.
    files: ['test/**/*.ts', '*.config.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
    },
  },
);
