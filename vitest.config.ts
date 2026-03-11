import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    alias: {
      vscode: path.resolve(__dirname, 'tests/helpers/mockVscode.ts'),
    },
  },
});
