import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'out/', 'dist/', 'release/', 'node_modules/', 'engine/', '.venv/',
      '*.js',
      'scripts/**/*.cjs', // CommonJS Node 脚本，用 require/module/console（ESM lint 规则不适用）
    ],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
)
