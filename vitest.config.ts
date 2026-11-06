import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';

const browserTests = [
  'tests/webview/*Browser.test.ts',
  // This integration suite also owns a real Chromium process.
  'tests/integration/chatInitialStateDelivery.test.ts',
];
const performanceTests = ['tests/webview/canvasPerfBrowser.test.ts'];

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['tests/setup.ts'],
    retry: 0,
    alias: {
      vscode: path.resolve(__dirname, 'tests/helpers/mockVscode.ts'),
    },
    // Vitest 5 inline projects inherit the shared setup and alias above.
    // Keep classification identical for release phases and direct file runs.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...browserTests],
          testTimeout: 5_000,
          maxWorkers: 2,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'browser',
          include: browserTests,
          exclude: [...configDefaults.exclude, ...performanceTests],
          // These are correctness journeys, including native browser/OS work.
          // Use the standard browser-test containment budget, not the unit
          // watchdog as an accidental UI latency assertion. This does not fix
          // native font latency or change explicit per-test timing checks.
          // https://playwright.dev/docs/test-timeouts
          testTimeout: 30_000,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'performance',
          include: performanceTests,
          testTimeout: 5_000,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
