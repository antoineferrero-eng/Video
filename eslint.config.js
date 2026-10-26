import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'data/**',
      'media/**',
      'coverage/**',
      'tools/demo-source/content/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['apps/server/**/*.{ts,mjs}', 'tools/**/*.ts', 'scripts/**/*.mjs', 'packages/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/desktop/src/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/desktop/src/*.cjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['apps/desktop/src/ui/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
