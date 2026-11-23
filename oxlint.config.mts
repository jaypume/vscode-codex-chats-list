import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc'],
  categories: { correctness: 'error' },
  env: { node: true },
  rules: {
    'typescript/no-explicit-any': 'error',
    'typescript/consistent-type-imports': ['error', { prefer: 'type-imports' }],
  },
});
