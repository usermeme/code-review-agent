import js from '@eslint/js';
import nx from '@nx/eslint-plugin';
import { defineConfig } from 'eslint/config';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

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
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    // Type-aware linting for the app and lib code.
    files: ['apps/**/*.ts', 'libs/**/*.ts'],
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
      '@typescript-eslint/no-explicit-any': 'error',
      // Fire-and-forget is deliberate in the webhook path; require the `void` marker.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: true },
      ],
    },
  },
  {
    // Dependency direction between projects (tags live in each project.json):
    // agents never import each other or apps, and shared/util libs stay leaves.
    // e2e projects are exempt: they build the real app from its sources.
    files: ['apps/**/*.ts', 'libs/**/*.ts'],
    ignores: ['apps/*-e2e/**'],
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          allow: [],
          depConstraints: [
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: [
                'type:agent',
                'type:util',
                'type:shared',
              ],
            },
            {
              sourceTag: 'type:agent',
              onlyDependOnLibsWithTags: ['type:util', 'type:shared'],
            },
            {
              sourceTag: 'type:util',
              onlyDependOnLibsWithTags: ['type:util', 'type:shared'],
            },
            {
              sourceTag: 'type:shared',
              onlyDependOnLibsWithTags: ['type:shared'],
            },
          ],
        },
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
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
