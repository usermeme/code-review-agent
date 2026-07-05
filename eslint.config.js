import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  {
    // Type-aware linting for the app code (tsconfig covers src only).
    files: ['src/**/*.ts'],
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
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Fire-and-forget is deliberate in the webhook path; require the `void` marker.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
    },
  },
  {
    // Tests and tool configs: recommended rules without type information —
    // they sit outside the build tsconfig, and fixtures legitimately bend types.
    files: ['test/**/*.ts', '*.config.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
