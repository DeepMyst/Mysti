const js = require('@eslint/js');
const ts = require('@typescript-eslint/eslint-plugin');
const parser = require('@typescript-eslint/parser');
const globals = require('globals');

// Flat configuration is required by ESLint 10. Keep browser globals confined to
// the webview scripts; the host uses TypeScript's declarations instead.
module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'resources/**', '**/*.min.js', 'out-test/**', 'out-vscode-test/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { '@typescript-eslint': ts },
    rules: {
      ...js.configs.recommended.rules,
      ...ts.configs['eslint-recommended'].overrides[0].rules,
      ...ts.configs.recommended.rules,
      '@typescript-eslint/naming-convention': ['warn', {
        selector: 'memberLike', modifiers: ['private'], format: ['camelCase'], leadingUnderscore: 'require',
      }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      curly: 'warn', eqeqeq: 'warn', 'no-throw-literal': 'warn', semi: 'warn',
    },
  },
  {
    files: ['media/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022, sourceType: 'script',
      globals: {
        ...globals.browser, ...globals.es2022,
        acquireVsCodeApi: 'readonly', Prism: 'readonly', marked: 'readonly',
        DOMPurify: 'readonly', mermaid: 'readonly', __MYSTI_BOOT__: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-control-regex': 'off', 'no-redeclare': 'warn',
      curly: 'warn', eqeqeq: 'warn', 'no-throw-literal': 'warn', semi: 'warn',
    },
  },
];
