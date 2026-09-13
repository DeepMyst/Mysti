/** The Canvas shell displays parsed pages; migration and parsing stay in the host. */
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('Canvas browser dependency boundary', () => {
  it('builds the actual browser entry without migration or the JSX parser', async () => {
    const result = await build({
      absWorkingDir: path.resolve(__dirname, '../..'),
      entryPoints: ['src/webview/canvas/index.ts'],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile!.inputs).map(input => input.replace(/\\/g, '/'));
    expect(inputs).toContain('src/canvas/pageView.ts');
    expect(inputs).toContain('src/webview/canvas/app.ts');
    expect(inputs.filter(input => /(?:@babel\/parser\/|canvas\/pageMigration\.ts$|canvas\/doc\/PageCompiler\.ts$)/.test(input))).toEqual([]);
  });
});
