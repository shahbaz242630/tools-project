import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.next/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
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
    files: ['**/*.test.ts', 'packages/core/src/time.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
