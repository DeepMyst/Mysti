import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    // Native CLI and browser fixtures spawn their own processes. Leave capacity
    // for those children instead of starting one test worker per CPU.
    maxWorkers: 4,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    alias: {
      vscode: path.resolve(__dirname, 'tests/helpers/mockVscode.ts'),
    },
  },
});
