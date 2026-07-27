import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.next/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Timestamps must go through @platform/core so timezone handling stays
      // explicit. A naive `new Date()` in domain code is how DST bugs get in.
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message:
            'Use @platform/core Time helpers so timezone handling stays explicit.',
        },
      ],
    },
  },
  {
    // The time module is the one place allowed to touch Date directly, and
    // tests need it to build fixtures.
    files: ['**/*.test.ts', 'packages/core/src/time.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // apps/api compiles with emitDecoratorMetadata, and NestJS resolves
    // constructor dependencies from the metadata it emits. A type-only import
    // erases that metadata, so applying consistent-type-imports here produces
    // code that compiles cleanly and then injects `undefined` at runtime —
    // verified by reverting it and watching all eight integration tests fail
    // inside the Nest injector.
    //
    // Scoped to this app rather than disabled globally: everywhere else the
    // rule is correct and the workspace is ESM. See ADR 0011.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
);
