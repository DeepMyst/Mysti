import { describe, expect, it } from 'vitest';
import path from 'node:path';
import ts from 'typescript';

const { validateProjectRoots } = require('../../scripts/check-minimum-node-types.cjs');
const roots = ['src/extension.ts', 'src/services/deskIrohWorker.ts',
  'types/minimum-node/globals.d.ts', 'tests-runtime/minimum-node-types.ts'];
const bundles = [
  { name: 'extension', target: 'node', entry: './src/extension.ts' },
  { name: 'worker', target: 'node', entry: './src/services/deskIrohWorker.ts' },
  { name: 'browser', target: 'web', entry: './src/webview/canvas.ts' },
];

describe('minimum Node type project roots', () => {
  for (const [root, paths] of [['C:\\work\\Mysti', path.win32], ['/work/Mysti', path.posix]] as const) {
    it(`accepts TypeScript-normalized host paths under ${root}`, () => {
      const config = ts.parseJsonConfigFileContent({ files: roots, compilerOptions: { noEmit: true } }, ts.sys, root);
      expect(() => validateProjectRoots(config, bundles, root, paths)).not.toThrow();
      for (const file of roots) {
        const incomplete = { ...config, fileNames: config.fileNames.filter(name => !name.endsWith(file)) };
        expect(() => validateProjectRoots(incomplete, bundles, root, paths)).toThrow();
      }
      expect(() => validateProjectRoots({ ...config, options: { noEmit: false } }, bundles, root, paths)).toThrow();
      expect(() => validateProjectRoots(config, [...bundles, { name: 'new-worker', target: 'node', entry: './src/newWorker.ts' }], root, paths)).toThrow('new-worker');
    });
  }
});
