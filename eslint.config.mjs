import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    // Test fixtures are data, not source. Workflow script fixtures legally use
    // top-level `return` (they run in the Workflow runtime's async context),
    // which the default parser rejects — exclude the whole fixtures tree.
    ignores: ['src/__fixtures__/**'],
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.webview.json'],
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
];
