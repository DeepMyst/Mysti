import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

interface Archive {
  files: Array<{ rel: string; size: number }>;
  readText(rel: string): string;
}
interface Result {
  failures: Array<{ assertion: string; message: string; details: string[] }>;
  notes: string[];
}
const { inspectArchive } = createRequire(import.meta.url)('../../scripts/check-package-shape.js') as {
  inspectArchive(archive: Archive, manifest: Record<string, unknown>): Result;
};

function archive(contents: Record<string, string>): Archive {
  return {
    files: Object.entries(contents).map(([rel, value]) => ({ rel, size: Buffer.byteLength(value) })),
    readText: rel => {
      if (!(rel in contents)) { throw new Error(`Missing ${rel}`); }
      return contents[rel];
    },
  };
}
const manifest = { main: './dist/extension.js' };

describe('package shape inspects the artifact contents', () => {
  it('accepts host-provided modules, Node builtins and intentional optional externals', () => {
    const result = inspectArchive(archive({ 'dist/extension.js':
      'require("vscode"); require("node:fs/promises"); require("bufferutil"); require("utf-8-validate");',
    }), manifest);
    expect(result.failures).toEqual([]);
  });

  it('rejects an absent extension entrypoint even when another bundle exists', () => {
    const result = inspectArchive(archive({ 'dist/canvasWebview.js': 'const canvas = true;' }), manifest);
    expect(result.failures.some(f => /entrypoint is missing/.test(f.message))).toBe(true);
  });

  it('rejects a package with no bundles', () => {
    expect(inspectArchive(archive({}), manifest).failures.some(f => /bundle is missing/.test(f.message))).toBe(true);
  });

  it('rejects a missing runtime external while ignoring require text in strings and comments', () => {
    const result = inspectArchive(archive({ 'dist/extension.js': `
      const generatedCode = 'require("not-executed")';
      // require("also-not-executed")
      require("playwright");
    ` }), manifest);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].details).toEqual([
      "require('playwright')  - no node_modules/playwright/package.json in the package",
    ]);
  });

  it('accepts an external included in the archive', () => {
    const result = inspectArchive(archive({
      'dist/extension.js': 'require("playwright");',
      'node_modules/playwright/package.json': '{"main":"index.js"}',
      'node_modules/playwright/index.js': 'module.exports = {};',
    }), manifest);
    expect(result.failures).toEqual([]);
  });

  it('fails when an archive lists a bundle that cannot be read', () => {
    const broken = archive({ 'dist/extension.js': '' });
    broken.readText = () => { throw new Error('corrupt ZIP entry'); };
    expect(inspectArchive(broken, manifest).failures.some(f => /Could not read dist\/extension.js/.test(f.message))).toBe(true);
  });

  it.each(['const = ;', 'const duplicate = 1; const duplicate = 2;'])(
    'fails on an invalid JavaScript bundle: %s', source => {
      expect(inspectArchive(archive({ 'dist/extension.js': source }), manifest).failures
        .some(f => /parse/.test(f.message))).toBe(true);
    },
  );

  it('uses the supplied artifact manifest to check walkthrough media', () => {
    const result = inspectArchive(archive({ 'dist/extension.js': 'module.exports = {};' }), {
      ...manifest,
      contributes: { walkthroughs: [{ id: 'start', steps: [{ id: 'one', media: {
        image: { light: 'resources/light.png', dark: 'resources/dark.png' },
      } }] }] },
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].details).toEqual([
      'resources/light.png   <- start / one', 'resources/dark.png   <- start / one',
    ]);
  });

  it('rejects debug maps, declarations and unreviewed large assets', () => {
    const result = inspectArchive(archive({
      'dist/extension.js': 'module.exports = {};', 'dist/extension.js.map': '{}',
      'dist/extension.d.ts': 'export {};', 'resources/unexpected.bin': 'x'.repeat(110_000),
    }), manifest);
    expect(result.failures.map(f => f.assertion)).toEqual([
      'B (no source maps)', 'C (no .d.ts)', 'G (large assets allowlisted)',
    ]);
  });

  it('does not retain findings from a previously inspected artifact', () => {
    const failed = inspectArchive(archive({}), manifest);
    expect(failed.failures.length).toBeGreaterThan(0);
    const passed = inspectArchive(archive({ 'dist/extension.js': 'module.exports = {};' }), manifest);
    expect(passed.failures).toEqual([]);
    expect(failed.failures.length).toBeGreaterThan(0);
  });
});
