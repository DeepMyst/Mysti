/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 A-3 — the packaging manifest, pinned.
 *
 * Everything here is currently CORRECT. That is exactly why it needs a test:
 * each one of these was wrong at some point in this repo's history, each was
 * fixed by hand, and none of them is checked by `tsc`, by `npm test`, or by any
 * CI (there is none). The failure mode is uniform — the extension still builds,
 * still type-checks, still passes every other test, and ships broken.
 *
 * Every assertion here is about a CLASS of thing, never about a file COUNT.
 * Counts were measured against a fresh build and did not reproduce against the
 * committed artifact, so a count assertion would be a permanent false alarm.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const vscodeignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');

// ---------------------------------------------------------------------------
// A minimal .vscodeignore evaluator (gitignore-shaped: last match wins,
// `!` re-includes). vsce applies the patterns in file order, so a `!` rule only
// works when it comes AFTER the rule that ignored the path — which is the part
// people get wrong.
// ---------------------------------------------------------------------------
function toRegExp(pattern: string): RegExp {
  // No gitignore-style basename fallback: vsce matches each pattern against the
  // path with `*` NOT crossing `/`, which is precisely why a bare `*.map` only
  // catches the repo root. The TEXT assertions below are the binding ones —
  // they hold whichever way the tool resolves it — and these path checks are
  // the supporting evidence.
  //
  // `!(...)` is minimatch's extglob "any segment NOT matching this". It is used
  // in .vscodeignore to keep Playwright's runtime files while dropping its
  // 2 MB of `.d.ts`, so this evaluator has to understand it or the supporting
  // checks below silently answer the wrong question.
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '!' && pattern[i + 1] === '(') {
      const close = pattern.indexOf(')', i);
      if (close !== -1) {
        const inner = toRegExp(pattern.slice(i + 2, close)).source.replace(/^\^|\$$/g, '');
        out += `(?!${inner}$)[^/]*`;
        i = close;
        continue;
      }
    }
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (ch === '*') { out += '[^/]*'; }
    else if (ch === '?') { out += '[^/]'; }
    else { out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
  }
  return new RegExp(`^${out}$`);
}

interface Rule { negated: boolean; re: RegExp; raw: string }

const rules: Rule[] = vscodeignore
  .split('\n')
  .map(l => l.trim())
  .filter(l => l.length > 0 && !l.startsWith('#'))
  .map(raw => raw.startsWith('!')
    ? { negated: true, re: toRegExp(raw.slice(1)), raw }
    : { negated: false, re: toRegExp(raw), raw });

/** True when the path would NOT be in the VSIX. */
function isIgnored(rel: string): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.re.test(rel)) { ignored = !rule.negated; }
  }
  return ignored;
}

describe('the .vscodeignore evaluator itself is trustworthy', () => {
  // A matcher that silently matches nothing would make every assertion below
  // pass vacuously. Pin its behaviour on cases whose answers are not in doubt.
  it('agrees with the obvious cases', () => {
    expect(isIgnored('src/extension.ts')).toBe(true);          // src/**
    expect(isIgnored('tests/utils/manifestPackaging.test.ts')).toBe(true);
    expect(isIgnored('dist/extension.js.map')).toBe(true);      // **/*.map, at depth
    expect(isIgnored('dist/extension.js')).toBe(false);
    expect(isIgnored('package.json')).toBe(false);
    expect(isIgnored('resources/icons/claude.svg')).toBe(false);
    expect(isIgnored('media/chat/chat.js')).toBe(false);
  });
});

describe('version is publishable on the pre-release channel', () => {
  // https://code.visualstudio.com/api/working-with-extensions/publishing-extension
  // "We only support major.minor.patch for extension versions, semver
  //  pre-release tags are not supported."
  // "We recommend that extensions use major.EVEN_NUMBER.patch for release
  //  versions and major.ODD_NUMBER.patch for pre-release versions."
  it('is bare major.minor.patch with no semver pre-release tag', () => {
    expect(
      /^\d+\.\d+\.\d+$/.test(pkg.version),
      `version "${pkg.version}" — the Marketplace rejects semver pre-release tags (e.g. 1.2.3-beta).`,
    ).toBe(true);
  });

  it('has a script for whichever channel its minor implies', () => {
    // The EVEN/ODD minor rule is a vendor RECOMMENDATION, not a Marketplace
    // limitation (unlike the pre-release-tag rule pinned above), and which
    // channel to cut on is the maintainer's decision — so asserting "the minor
    // must be odd" would have failed the moment anyone cut 0.6.0 or 1.0.0, i.e.
    // it blocks the release it is supposed to be guarding.
    //
    // What IS binding: do not sit on a version whose channel you cannot build.
    const minor = Number(pkg.version.split('.')[1]);
    expect(Number.isInteger(minor)).toBe(true);
    const scripts = Object.values(pkg.scripts as Record<string, string>);
    const channel = minor % 2 === 1 ? 'pre-release' : 'release';
    const buildable = channel === 'pre-release'
      ? scripts.some(c => /--pre-release\b/.test(c))
      : scripts.some(c => /vsce\s+package\b/.test(c) && !/--pre-release\b/.test(c));
    expect(buildable,
      `version "${pkg.version}" has a ${minor % 2 === 1 ? 'ODD' : 'EVEN'} minor, which the VS Code docs `
      + `associate with the ${channel} channel, but no npm script cuts that channel.`).toBe(true);
  });
});

describe('workspace-trust and virtual-workspace capabilities are declared', () => {
  // Undeclared, VS Code assumes SUPPORTED and silently enables the extension in
  // an untrusted or virtual workspace — where spawning CLIs and writing files
  // is exactly what must not happen.
  for (const cap of ['untrustedWorkspaces', 'virtualWorkspaces']) {
    it(`capabilities.${cap} is declared with an explicit supported flag and a reason`, () => {
      const value = pkg.capabilities?.[cap];
      expect(value, `capabilities.${cap} is missing — VS Code then assumes support.`).toBeDefined();
      // Pinning only the TYPE of `supported` let the one change this block
      // exists to prevent — flipping it to `true` — pass unnoticed. Mysti
      // spawns CLIs, writes files and reaches the network on the user's behalf;
      // neither an untrusted nor a virtual workspace may enable it.
      expect(value.supported,
        `capabilities.${cap}.supported must be false — see the description in package.json.`)
        .toBe(false);
      expect(String(value.description ?? '').length,
        `capabilities.${cap}.description is what the user is shown; it must say why.`)
        .toBeGreaterThan(20);
    });
  }
});

describe('engines', () => {
  it('declares both a vscode and a node engine', () => {
    expect(pkg.engines?.vscode, 'engines.vscode is required by the Marketplace').toBeTruthy();
    expect(
      pkg.engines?.node,
      'engines.node is absent. Without it nothing pins the Node the build and the packaged '
      + 'runtime assume, and a contributor on an older Node gets a runtime failure, not a build one.',
    ).toBeTruthy();
  });
});

describe('packaging scripts must collect dependencies', () => {
  const packageScripts = Object.entries(pkg.scripts as Record<string, string>)
    .filter(([name]) => /^package(:|$)/.test(name));

  it('there is at least one package script', () => {
    expect(packageScripts.length).toBeGreaterThan(0);
  });

  for (const [name, body] of packageScripts) {
    it(`"${name}" passes --dependencies`, () => {
      expect(body).toContain('--dependencies');
    });
  }

  it('NO script anywhere passes --no-dependencies', () => {
    // `vsce package --no-dependencies` never walks node_modules, so the two
    // `!node_modules/playwright*` un-ignores in .vscodeignore have nothing to
    // re-include and Playwright is simply absent from the VSIX. Measured on
    // this tree: `vsce ls` collected 689 files, `vsce ls --no-dependencies`
    // collected 140, and the entire difference was Playwright. Every packaged
    // build then fails `require('playwright')` and visual testing is dead on
    // arrival — with no build error and no test failure to say so.
    const offenders = Object.entries(pkg.scripts as Record<string, string>)
      .filter(([, body]) => body.includes('--no-dependencies'))
      .map(([name]) => name);
    expect(offenders, `--no-dependencies ships an extension without Playwright: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('.vscodeignore still re-includes playwright, which is what --dependencies is for', () => {
    expect(vscodeignore).toContain('!node_modules/playwright/**');
    expect(vscodeignore).toContain('!node_modules/playwright-core/**');
    expect(isIgnored('node_modules/playwright-core/cli.js')).toBe(false);
    expect(isIgnored('node_modules/some-other-package/index.js')).toBe(true);
  });

  it('every package script pins an exact vsce version, and vsce never ships', () => {
    // vsce is fetched per-invocation with a pinned version rather than declared
    // as a devDependency. A devDependency has to be mirrored into
    // package-lock.json; when it was added without one, `npm ci` failed with
    // EUSAGE and took EVERY CI job down at its Install step — including the two
    // blocking ones. Pinning in the script keeps the version reproducible and
    // removes the lock-drift class entirely. This must stay in step with
    // .github/workflows/ci.yml, which pins the same version.
    for (const [name, body] of packageScripts) {
      expect(body, `"${name}" must pin an exact vsce version, not a range`)
        .toMatch(/@vscode\/vsce@\d+\.\d+\.\d+/);
    }
    expect(pkg.dependencies?.['@vscode/vsce'],
      'The packaging tool must never ship inside the extension.').toBeUndefined();
    expect(pkg.devDependencies?.['@vscode/vsce'],
      'A vsce devDependency must be mirrored in package-lock.json or `npm ci` dies; the scripts pin it instead.')
      .toBeUndefined();
  });
});

describe('.vscodeignore globs are recursive where they must be', () => {
  it('source-map and TypeScript ignores are depth-independent', () => {
    // `*.map` (no `**/`) only matches the repo root, so every sourcemap under
    // dist/ shipped. The un-recursive form must not come back.
    const lines = vscodeignore.split('\n').map(l => l.trim());
    expect(lines).toContain('**/*.map');
    expect(lines, 'a bare `*.map` matches only the repo root').not.toContain('*.map');
    expect(lines).toContain('**/*.ts');
    expect(lines).not.toContain('*.ts');
    expect(isIgnored('dist/extension.js.map')).toBe(true);
    expect(isIgnored('media/chat/vendor/x.map')).toBe(true);
  });

  it('the playwright un-ignores re-include its RUNTIME files but not its .d.ts', () => {
    // `**/*.ts` at the top of this file does not survive a bare
    // `!node_modules/playwright/**`: vsce re-includes anything matching ANY `!`
    // rule after all the ignore rules have run, so the negation is global, not
    // positional. Appending `node_modules/playwright/**/*.d.ts` below the
    // un-ignores was measured to change nothing (`vsce ls` stayed at 686 files,
    // all 9 declarations still listed) — the exclusion has to live inside the
    // negation, which is what `!(*.d.ts)` does.
    //
    // 2.03 MB shipped this way, playwright-core/types/types.d.ts alone being
    // 922 KB, and nothing reads a .d.ts at runtime.
    for (const decl of [
      'node_modules/playwright-core/types/types.d.ts',
      'node_modules/playwright-core/types/protocol.d.ts',
      'node_modules/playwright/types/test.d.ts',
      'node_modules/playwright/index.d.ts',
      'node_modules/playwright/node_modules/fsevents/fsevents.d.ts',
    ]) {
      expect(isIgnored(decl), `${decl} would ship; nothing reads a .d.ts at runtime`).toBe(true);
    }
    // ...and the runtime files this un-ignore exists for must still be there.
    for (const runtime of [
      'node_modules/playwright-core/cli.js',
      'node_modules/playwright-core/index.js',
      'node_modules/playwright/index.mjs',
      'node_modules/playwright/lib/index.js',
    ]) {
      expect(isIgnored(runtime), `${runtime} is gone — require('playwright') will throw in the VSIX`).toBe(false);
    }
  });
});

describe('fossils are excluded', () => {
  // KEPT on disk on purpose, and must never ship: a dead entrypoint that
  // `require`s a file nothing builds. The CLI-native `--permission-prompt-tool`
  // path it belonged to may be worth resurrecting (its replacement, stream-level
  // interception, is what failed open on Windows), so the file stays as the
  // record of that design.
  for (const fossil of ['resources/mcp-permission-server.js']) {
    it(`${fossil} is not packaged`, () => {
      expect(fs.existsSync(path.join(ROOT, fossil)), `${fossil} is gone; drop its .vscodeignore line too.`).toBe(true);
      expect(isIgnored(fossil), `${fossil} would ship.`).toBe(true);
    });
  }

  // DELETED 2026-09-05, not merely un-shipped: an MIT bundle whose copyright
  // banner had been stripped, redistributed under this repo's Apache-2.0 —
  // a licence-compliance defect, not just dead weight. It was 314 KB loaded by
  // no HTML and referenced only by the dead CanvasManager. Re-adding a vendored
  // asset requires a NOTICE entry (see the notice suite below), so this pins the
  // deletion rather than the ignore rule.
  it('resources/fabric.min.js is gone from the repository entirely', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'resources/fabric.min.js')),
      'fabric.min.js is back. It is an MIT bundle with its copyright banner stripped; '
      + 'if it is genuinely needed, restore the banner and add it to NOTICE.',
    ).toBe(false);
  });
});

describe('walkthrough media resolve on disk AND survive packaging', () => {
  const steps: Array<{ id: string; media: { image?: string; markdown?: string; svg?: string; altText?: string } }> =
    (pkg.contributes.walkthroughs ?? []).flatMap((w: { steps: unknown[] }) => w.steps as never[]);

  it('the walkthrough still has its full set of steps', () => {
    // A floor, not an equality: this file's own header says every assertion is
    // about a CLASS of thing, never a COUNT, and a SIXTH walkthrough step is
    // not a packaging defect. Losing one silently is.
    expect(steps.length).toBeGreaterThanOrEqual(5);
  });

  for (const step of steps) {
    const asset = step.media?.image ?? step.media?.markdown ?? step.media?.svg;
    it(`step "${step.id}" media ${asset} exists and is not ignored`, () => {
      expect(asset, `step ${step.id} declares no media asset`).toBeTruthy();
      expect(fs.existsSync(path.join(ROOT, asset as string)), `${asset} does not exist on disk`).toBe(true);
      // Four of these live under docs/, which .vscodeignore excludes wholesale —
      // they are re-included by explicit `!` rules placed after it. Drop one of
      // those and the step renders as a broken image in every install, with
      // nothing else failing.
      expect(isIgnored(asset as string), `${asset} is excluded from the VSIX; the step ships broken.`).toBe(false);
    });
  }
});

describe('mysti.mysti.skills is described honestly', () => {
  const cfg = pkg.contributes.configuration;
  const props: Record<string, { description?: string; markdownDescription?: string; enum?: string[] }> =
    Array.isArray(cfg) ? Object.assign({}, ...cfg.map((c: { properties: object }) => c.properties)) : cfg.properties;
  const text = `${props['mysti.mysti.skills']?.description ?? ''} ${props['mysti.mysti.skills']?.markdownDescription ?? ''}`;

  it('is declared', () => {
    expect(props['mysti.mysti.skills']).toBeDefined();
  });

  it('no longer claims the capability is unimplemented', () => {
    // The description shipped saying `full` was "not implemented yet" and
    // "behaves as prose" long after Plan 20 Phases 3-4 landed. A setting whose
    // own text tells the user it does nothing is a setting nobody turns on.
    for (const stale of ['not implemented yet', 'behaves as prose', 'behaves as `prose`', 'no-op']) {
      expect(text.toLowerCase(), `the description still says "${stale}"`).not.toContain(stale.toLowerCase());
    }
  });

  it('names the co-conditions, because `full` alone grants nothing', () => {
    // `full` is necessary-but-not-sufficient; without these named, a user who
    // flips it and sees no change has no way to find out why.
    for (const condition of ['localExecution', 'trusted', 'sandbox']) {
      expect(text, `the description must name "${condition}" as a co-condition of \`full\``)
        .toContain(condition);
    }
  });
});
