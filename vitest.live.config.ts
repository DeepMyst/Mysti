import { defineConfig } from 'vitest/config';
import path from 'path';

// Deliberately separate: these tests use existing CLI logins and model quota.
export default defineConfig({ test: {
  include: ['tests-live/**/*.test.ts'], fileParallelism: false,
  alias: { vscode: path.resolve(__dirname, 'tests/helpers/mockVscode.ts') },
} });
