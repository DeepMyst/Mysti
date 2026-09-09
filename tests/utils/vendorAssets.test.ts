/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const scratch: string[] = [];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(() => {
  for (const dir of scratch.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-vendor-check-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'resources'));
  fs.copyFileSync(path.resolve(__dirname, '../../scripts/check-vendor.js'), path.join(dir, 'scripts/check-vendor.js'));
  const record = { version: '1.0.0', integrity: 'sha512-test' };
  const manifest = {
    buildScriptSha256: digest('// build'), webpackVersion: '1.0.0',
    packages: { 'node_modules/mermaid': record, 'node_modules/dompurify': record },
    buildPackages: { 'node_modules/webpack': record, 'node_modules/terser-webpack-plugin': record },
    assets: { 'mermaid.min.js': digest('// asset'), 'mermaid.min.js.LICENSE.txt': digest('MIT') },
  };
  const lock = { packages: { ...manifest.packages, ...manifest.buildPackages } };
  fs.writeFileSync(path.join(dir, 'scripts/build-vendor.js'), '// build');
  fs.writeFileSync(path.join(dir, 'resources/mermaid.min.js'), '// asset');
  fs.writeFileSync(path.join(dir, 'resources/mermaid.min.js.LICENSE.txt'), 'MIT');
  const save = () => {
    fs.writeFileSync(path.join(dir, 'resources/mermaid.provenance.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  };
  save();
  const check = () => spawnSync(process.execPath, [path.join(dir, 'scripts/check-vendor.js')], { encoding: 'utf8' });
  return { dir, manifest, lock, save, check };
}

describe('vendored asset verification', () => {
  it('accepts matching build inputs and artifacts', () => {
    const result = fixture().check();
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts the renamed webpack minimizer only when its provenance matches the lock', () => {
    const f = fixture();
    const buildPackages = f.manifest.buildPackages as Record<string, { version: string; integrity: string }>;
    const lockPackages = f.lock.packages as typeof buildPackages;
    buildPackages['node_modules/minimizer-webpack-plugin'] = buildPackages['node_modules/terser-webpack-plugin'];
    lockPackages['node_modules/minimizer-webpack-plugin'] = lockPackages['node_modules/terser-webpack-plugin'];
    delete buildPackages['node_modules/terser-webpack-plugin'];
    delete lockPackages['node_modules/terser-webpack-plugin'];
    f.save();
    expect(f.check().status).toBe(0);
    lockPackages['node_modules/minimizer-webpack-plugin'] = { version: '2.0.0', integrity: 'sha512-new' };
    f.save();
    expect(f.check().status).toBe(1);
  });

  it('rejects provenance that omits the minimizer', () => {
    const f = fixture();
    delete (f.manifest.buildPackages as Record<string, unknown>)['node_modules/terser-webpack-plugin'];
    f.save();
    expect(f.check().status).toBe(1);
  });

  it('rejects incomplete provenance instead of validating empty maps', () => {
    const f = fixture();
    f.manifest.assets = {} as typeof f.manifest.assets;
    f.save();
    const result = f.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('provenance is incomplete');
  });

  it('requires a rebuild when an audited dependency changes', () => {
    const f = fixture();
    f.lock.packages['node_modules/dompurify'] = { version: '1.0.1', integrity: 'sha512-new' };
    f.save();
    const result = f.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Bundled dependency changed: node_modules/dompurify');
  });

  it('rejects an asset modified without rebuilding its provenance', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.dir, 'resources/mermaid.min.js'), 'corruption');
    const result = f.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Vendored asset changed: mermaid.min.js');
  });
});
