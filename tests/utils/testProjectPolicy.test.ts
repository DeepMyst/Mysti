import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import config from '../../vitest.config';

const require = createRequire(import.meta.url);
const { getTestPlan } = require('../../scripts/test-release.cjs');
const root = path.resolve(__dirname, '../..');
const projects = config.test!.projects as Array<{ test: {
  name: string; include: string[]; exclude?: string[]; testTimeout: number;
  maxWorkers: number; sequence: { groupOrder: number };
} }>;

function owners(file: string): string[] {
  return projects.filter(({ test }) =>
    test.include.some(pattern => path.posix.matchesGlob(file, pattern)) &&
    !test.exclude?.some(pattern => path.posix.matchesGlob(file, pattern)),
  ).map(({ test }) => test.name);
}

function testFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(file) : file.endsWith('.test.ts') ? [file] : [];
  });
}

describe('test project ownership and containment', () => {
  it('assigns every test exactly once and keeps actual Chromium owners out of unit', () => {
    for (const absolute of testFiles(path.join(root, 'tests'))) {
      const file = path.relative(root, absolute).split(path.sep).join('/');
      const selected = owners(file);
      expect(selected, file).toHaveLength(1);
      if (/\bchromium\s*\.\s*launch\s*\(/.test(fs.readFileSync(absolute, 'utf8'))) {
        expect(selected[0], file).not.toBe('unit');
      }
    }
  });

  it('classifies direct paths and future browser suites without release-runner file lists', () => {
    expect(owners('tests/webview/futureFeatureBrowser.test.ts')).toEqual(['browser']);
    expect(owners('tests/integration/chatInitialStateDelivery.test.ts')).toEqual(['browser']);
    expect(owners('tests/webview/canvasPerfBrowser.test.ts')).toEqual(['performance']);
    expect(owners('tests/webview/futureFeature.test.ts')).toEqual(['unit']);
    expect(owners('tests-live/conversations.test.ts')).toEqual([]);
    for (const { test } of projects) {
      expect(getTestPlan(test.name)).toEqual({ project: test.name });
    }
    expect(() => getTestPlan('unknown')).toThrow('Usage:');
  });

  it('keeps unit/performance limits distinct and direct runs phase-isolated without retries', () => {
    expect(projects.map(({ test }) => [test.name, test.testTimeout, test.maxWorkers, test.sequence.groupOrder]))
      .toEqual([
        ['unit', 5_000, 2, 0],
        ['browser', 30_000, 1, 1],
        ['performance', 5_000, 1, 2],
      ]);
    expect(config.test!.retry).toBe(0);
    expect(config.test!.setupFiles).toEqual(['tests/setup.ts']);
    expect(config.test!.alias).toEqual({ vscode: path.join(root, 'tests/helpers/mockVscode.ts') });
  });
});
