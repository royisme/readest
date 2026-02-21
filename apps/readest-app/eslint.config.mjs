import { defineConfig, globalIgnores } from 'eslint/config';
import next from 'eslint-config-next';
import nextVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...tseslint,
  ...next,
  ...nextVitals,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  globalIgnores([
    'node_modules/**',
    '.next/**',
    '.open-next/**',
    'out/**',
    'build/**',
    'public/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
