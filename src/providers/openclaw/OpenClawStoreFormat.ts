/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'fs';
import * as path from 'path';

export type OpenClawStoreFormat = 'json' | 'sqlite' | 'unknown';

function selectedPackageVersion(cliPath: string, cwd: string): string | undefined {
  try {
    // A bare command can resolve differently on PATH. Use its discovery version
    // instead of treating a coincidental file in the workspace as the CLI.
    if (!path.isAbsolute(cliPath) && !cliPath.includes('/') && !cliPath.includes('\\')) { return; }
    const entry = fs.realpathSync(path.resolve(cwd, cliPath));
    let directory = path.dirname(entry);
    for (let depth = 0; depth < 4; depth++) {
      const manifest = path.join(directory, 'package.json');
      try {
        if (fs.statSync(manifest).size <= 256 * 1024) {
          const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.openclaw;
          if (pkg.name === 'openclaw' && typeof pkg.version === 'string' && typeof bin === 'string'
            && fs.realpathSync(path.resolve(directory, bin)) === entry) { return pkg.version; }
        }
      } catch { /* Missing/unreadable/unrelated metadata: retain discovery evidence. */ }
      const parent = path.dirname(directory);
      if (parent === directory) { break; }
      directory = parent;
    }
  } catch { /* Standalone executables and wrappers can use their discovered version. */ }
  return undefined;
}

/** No runtime imports, version probes, migrations or writes during readiness. */
export function resolveOpenClawStoreFormat(cliPath: string, cachedVersion: string | null, cwd: string): OpenClawStoreFormat {
  // Re-read the selected package so replacement/upgrades do not retain an old
  // discovery result. Require its declared bin to match, including symlinks.
  const version = selectedPackageVersion(cliPath, cwd) ?? cachedVersion;
  const match = version?.trim().match(/^(?:OpenClaw\s+)?v?(\d{4})\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[^\s]+)?(?:\s|$)/i);
  if (!match) { return 'unknown'; }
  const number = Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
  // Upstream v2026.6.1 loads JSON; v2026.6.5 and the installed v2026.6.34
  // load SQLite without falling back to retired JSON stores. Unqualified
  // transition builds retain compatibility instead of guessing a migration.
  if (number <= 20260601) { return 'json'; }
  if (number > 20260605 || (number === 20260605 && !match[4])) { return 'sqlite'; }
  return 'unknown';
}
