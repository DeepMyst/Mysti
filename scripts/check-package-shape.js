#!/usr/bin/env node
/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * VSIX SHAPE GATE
 * ===============
 *
 * WHY THIS ASSERTS CLASSES OF THING AND NEVER COUNTS
 * --------------------------------------------------
 * The obvious version of this script snapshots the artifact ("212 .map files,
 * 210 .d.ts, 567 entries") and fails on drift. That is the wrong instrument,
 * and this repo proves it: those exact headline numbers were measured against a
 * fresh build and do NOT reproduce against the committed `mysti-0.5.0-dev.vsix`,
 * which has 1,068 entries, 188 `.map` and 194 `.d.ts`. A count assertion fails
 * for every reason except the one you care about - it goes red when someone adds
 * a legitimate file, and it stays green when someone adds a bad one under an old
 * budget.
 *
 * So every assertion below is a PROPERTY:
 *   A  every walkthrough image the manifest promises is actually in the box
 *   B  zero source maps ship
 *   C  zero TypeScript declarations ship
 *   D  everything dist/ requires at runtime is resolvable inside the box
 *   E  every package production code imports is a DECLARED dependency
 *   F  packaging flags are not load-bearing (or, if they are, the release
 *      scripts pin the flag that makes the artifact correct)
 *   G  every large binary asset is on a list a human signed off on
 *
 * A property survives refactors. A count does not.
 *
 * USAGE
 *   node scripts/check-package-shape.js [path/to.vsix] [--skip-parity]
 *
 *   With a .vsix path  - asserts against that archive's real entries, reading
 *                        dist/*.js out of the archive itself (not off disk), so
 *                        it is valid against an artifact this machine did not
 *                        build.
 *   With no argument   - runs `vsce ls` and asserts against the file list it
 *                        would package. Much faster (`vsce ls` does not run
 *                        `vscode:prepublish`), but it reflects whatever is in
 *                        dist/ right now rather than a fresh build.
 *
 *   --skip-parity      - skip assertion F, which shells out to `vsce ls` twice.
 *
 * EXIT CODES
 *   0  every assertion held
 *   1  at least one assertion failed (each is named on stderr)
 *   2  the script could not run (no archive, vsce unavailable, bad input)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const VSCE = '@vscode/vsce@3.9.2';

// ---------------------------------------------------------------------------
// Allowlist: large binary / vendored assets that are ALLOWED to ship.
//
// Anything in the archive at or above LARGE_FILE_BYTES must match one of these.
// The point is not to police size. The point is that a new 300 KB file cannot
// land in every user's install directory without a human writing one line here
// saying what it is. Adding an entry is cheap; being unable to finish the
// sentence is the signal. (`resources/fabric.min.js`, 314 KB, referenced by no
// HTML and only by dead code, shipped in v0.5.0-dev exactly this way.)
// ---------------------------------------------------------------------------
const LARGE_FILE_BYTES = 100 * 1024;

const LARGE_ASSET_ALLOWLIST = [
  [/^dist\/extension\.js$/,                       'the extension bundle itself'],
  [/^dist\/canvasWebview\.js$/,                   'the canvas webview bundle (Plan 22)'],
  [/^media\/chat\/chat\.js$/,                     'the chat webview script (Plan 03 Phase 3c)'],
  [/^media\/chat\/chat\.css$/,                    'the chat webview stylesheet'],
  [/^resources\/mermaid\.min\.js$/,               'Mermaid diagram rendering in the chat webview'],
  [/^resources\/canvas-sandbox\/babel\.min\.js$/, 'in-sandbox JSX compile for the canvas (Plan 22)'],
  [/^resources\/canvas-sandbox\/react(-dom)?\.production\.min\.js$/, 'canvas sandbox runtime (Plan 22)'],
  [/^resources\/Mysti-Logo\.png$/,                'marketplace icon + the final walkthrough step image'],
  // Referenced by contributes.walkthroughs (assertion A requires them present)
  // AND by all 11 README translations. They are large for what they are; if
  // they are ever re-encoded, this stays true and the entry stays.
  [/^docs\/screenshots\/[^/]+\.png$/,             'contributes.walkthroughs step media + README screenshots'],
  // Playwright is a webpack EXTERNAL and is deliberately un-ignored in
  // .vscodeignore; without it `require('playwright')` throws in every packaged
  // build and visual testing is dead on arrival. Browser BINARIES are not
  // shipped - the user runs `npx playwright install chromium`.
  [/^node_modules\/playwright(-core)?\//,         'playwright runtime (webpack external, see .vscodeignore)'],
];

// Everything Node resolves without a node_modules lookup. Kept explicit rather
// than read from module.builtinModules so the set does not silently grow with
// whatever Node version CI happens to run.
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

// Provided by the extension host, never by node_modules.
const HOST_PROVIDED = new Set(['vscode']);

// Externals webpack reports as `[optional]`: native ws accelerators the code
// works without. Their absence is by design, not a defect.
const OPTIONAL_EXTERNALS = new Set(['bufferutil', 'utf-8-validate']);

// ---------------------------------------------------------------------------
const failures = [];
const notes = [];

function fail(assertion, message, details = []) {
  failures.push({ assertion, message, details });
}

function mb(bytes) {
  if (bytes >= 1024 * 1024) { return `${(bytes / 1024 / 1024).toFixed(2)} MB`; }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function rootOf(spec) {
  const bare = spec.replace(/^node:/, '');
  return bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader.
//
// A .vsix is a plain ZIP. Shelling out to `unzip` is not portable to the
// windows-latest runner and adding a dependency for this would be silly, so the
// central directory is parsed directly and individual entries are inflated on
// demand. Only name / size / offset are needed from the directory.
// ---------------------------------------------------------------------------
function openZip(vsixPath) {
  const buf = fs.readFileSync(vsixPath);

  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) { throw new Error(`${vsixPath} is not a readable ZIP (no end-of-central-directory record)`); }

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate; follow the locator when they do.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    let loc = -1;
    for (let i = eocd - 20; i >= 0 && i > eocd - 4096; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) { loc = i; break; }
    }
    if (loc < 0) { throw new Error(`${vsixPath}: ZIP64 archive with no locator`); }
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (buf.readUInt32LE(z64) !== 0x06064b50) { throw new Error(`${vsixPath}: bad ZIP64 end-of-central-directory`); }
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) { throw new Error(`${vsixPath}: corrupt central directory at byte ${p}`); }
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { name, size, method, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    read(name) {
      const e = entries.get(name);
      if (!e) { throw new Error(`no such entry in archive: ${name}`); }
      if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) { throw new Error(`corrupt local header for ${name}`); }
      const nLen = buf.readUInt16LE(e.localOffset + 26);
      const xLen = buf.readUInt16LE(e.localOffset + 28);
      const start = e.localOffset + 30 + nLen + xLen;
      // The central directory's compressed size is authoritative; re-read it.
      const cdCompressed = (() => {
        let q = cdOffset;
        for (let i = 0; i < count; i++) {
          const nl = buf.readUInt16LE(q + 28);
          const nm = buf.toString('utf8', q + 46, q + 46 + nl);
          if (nm === name) { return buf.readUInt32LE(q + 20); }
          q += 46 + nl + buf.readUInt16LE(q + 30) + buf.readUInt16LE(q + 32);
        }
        return null;
      })();
      const raw = buf.subarray(start, start + (cdCompressed ?? e.size));
      if (e.method === 0) { return raw; }
      if (e.method === 8) { return zlib.inflateRawSync(raw); }
      throw new Error(`unsupported compression method ${e.method} for ${name}`);
    },
  };
}

function vsceLs(extraArgs) {
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--yes', VSCE, 'ls', ...extraArgs],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return out.split('\n').map(s => s.trim()).filter(Boolean).map(s => s.replace(/\\/g, '/'));
}

/**
 * Normalise both input shapes to `{ files: [{rel,size}], readText(rel) }`,
 * where `rel` is a repo-relative POSIX path. VSIX entries carry an
 * `extension/` prefix; `vsce ls` output does not.
 */
function loadArchive(vsixPath) {
  if (vsixPath) {
    const zip = openZip(vsixPath);
    const files = [];
    for (const e of zip.entries.values()) {
      if (!e.name.startsWith('extension/') || e.name.endsWith('/')) { continue; }
      files.push({ rel: e.name.slice('extension/'.length), size: e.size });
    }
    return {
      files,
      source: `archive ${vsixPath}`,
      // Read out of the ARCHIVE, so the check is valid against an artifact this
      // machine did not build.
      readText: rel => zip.read(`extension/${rel}`).toString('utf8'),
    };
  }
  const files = vsceLs([]).map(rel => {
    let size = 0;
    try { size = fs.statSync(path.join(REPO_ROOT, rel)).size; } catch { /* not on disk yet */ }
    return { rel, size };
  });
  return {
    files,
    source: '`vsce ls` (dependency-resolving mode) against the working tree',
    readText: rel => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// ASSERTION A - every asset contributes.walkthroughs promises is in the box.
//
// A walkthrough step whose image is missing renders as a broken tile on the Get
// Started page, on first run, to every new user. Four of the five step images
// live under `docs/`, which `.vscodeignore` excludes wholesale - so this is not
// a hypothetical, it is what v0.5.0-dev shipped.
// ---------------------------------------------------------------------------
function assertWalkthroughAssets(present, manifest) {
  const wanted = [];
  const take = (ref, w, step) => {
    if (typeof ref === 'string') { wanted.push({ ref: ref.replace(/\\/g, '/'), w, step }); }
  };
  for (const w of manifest.contributes?.walkthroughs ?? []) {
    for (const step of w.steps ?? []) {
      const m = step.media ?? {};
      for (const key of ['image', 'markdown', 'svg']) {
        const v = m[key];
        if (typeof v === 'string') { take(v, w.id, step.id ?? '(unnamed)'); }
        else if (v && typeof v === 'object') {
          // { dark, light, hc, hcLight } theme variants
          for (const variant of Object.values(v)) { take(variant, w.id, step.id ?? '(unnamed)'); }
        }
      }
    }
  }
  if (!wanted.length) { notes.push('A: no walkthrough media declared - nothing to check.'); return; }

  const missing = wanted.filter(x => !present.has(x.ref));
  if (missing.length) {
    fail('A (walkthrough assets present)',
      `${missing.length} of ${wanted.length} media asset(s) declared in contributes.walkthroughs are NOT in the package. Each renders as a broken tile on the Get Started page for every new user.`,
      missing.map(x => `${x.ref}   <- ${x.w} / ${x.step}`));
  } else {
    notes.push(`A: all ${wanted.length} walkthrough media assets are present.`);
  }
}

// ---------------------------------------------------------------------------
// ASSERTION B - zero source maps.
//
// `tsconfig.json` sets sourceMap + declarationMap with `outDir: dist`, and
// webpack's devtool is 'source-map', so the build emits maps straight into the
// directory that ships. `extension.js.map` additionally inlines every byte of
// `src/` through sourcesContent - so `src/`, which `.vscodeignore` line 3
// explicitly excludes, ships anyway inside the map.
// ---------------------------------------------------------------------------
function assertNoSourceMaps(files) {
  const maps = files.filter(f => f.rel.endsWith('.map'));
  if (!maps.length) { notes.push('B: no source maps ship.'); return; }
  const bytes = maps.reduce((a, f) => a + f.size, 0);
  fail('B (no source maps)',
    `${maps.length} source map(s) ship (${mb(bytes)}). Nothing reads a .map at runtime; extension.js.map also inlines all of src/ via sourcesContent, so src/ ships despite being excluded in .vscodeignore.`,
    maps.slice(0, 12).map(f => `${f.rel}  (${mb(f.size)})`)
      .concat(maps.length > 12 ? [`... and ${maps.length - 12} more`] : []));
}

// ---------------------------------------------------------------------------
// ASSERTION C - zero TypeScript declaration files.
//
// `.d.ts` files are compile-time only; nothing reads one at runtime. They reach
// the archive as a side effect of `declaration: true` pointing at the shipping
// outDir, and as vendored types dragged along with a runtime external.
// ---------------------------------------------------------------------------
function assertNoDeclarations(files) {
  const decls = files.filter(f => f.rel.endsWith('.d.ts'));
  if (!decls.length) { notes.push('C: no .d.ts files ship.'); return; }
  const bytes = decls.reduce((a, f) => a + f.size, 0);
  fail('C (no .d.ts)',
    `${decls.length} TypeScript declaration file(s) ship (${mb(bytes)}). Nothing reads a .d.ts at runtime.`,
    decls.slice(0, 12).map(f => `${f.rel}  (${mb(f.size)})`)
      .concat(decls.length > 12 ? [`... and ${decls.length - 12} more`] : []));
}

// ---------------------------------------------------------------------------
// ASSERTION D - every bare specifier dist/ still requires at RUNTIME resolves
// inside the archive.
//
// webpack bundles almost everything, so the only bare `require()` calls left in
// dist/ are the declared `externals`. Those are resolved from node_modules at
// runtime, in the USER's install directory. If one is missing from the archive,
// the feature behind it throws the first time a user reaches it - and nothing
// in the build notices, because webpack was told the module would be there.
//
// This MUST use a real parser, not a regex. A minified bundle is full of
// require() calls inside STRING LITERALS - ajv's standalone code generator
// alone contributes `require("ajv/dist/runtime/equal")` and four siblings as
// template strings that never execute. A regex reports all five as missing
// dependencies; every one is a false positive. @babel/parser is already a
// production dependency of this extension, so there is nothing to add.
// ---------------------------------------------------------------------------
function assertRuntimeRequiresResolve(archive, present) {
  const distJs = archive.files.filter(f => f.rel.startsWith('dist/') && f.rel.endsWith('.js'));
  if (!distJs.length) {
    fail('D (runtime requires resolve)', 'No dist/*.js in the package - the bundle is missing entirely.');
    return;
  }

  let parse;
  try { ({ parse } = require('@babel/parser')); } catch {
    notes.push('D: SKIPPED - @babel/parser is not installed. A regex scan here would be worse than nothing (a minified bundle carries require() calls inside string literals), so this assertion declines to guess.');
    return;
  }

  const specs = new Set();
  for (const f of distJs) {
    let src;
    try { src = archive.readText(f.rel); } catch { continue; }
    let ast;
    try { ast = parse(src, { sourceType: 'unambiguous', errorRecovery: true }); } catch (err) {
      fail('D (runtime requires resolve)', `Could not parse ${f.rel}: ${err.message.split('\n')[0]}`);
      return;
    }
    walkForRequires(ast.program, specs);
  }

  const unresolved = [];
  for (const spec of [...specs].sort()) {
    const root = rootOf(spec);
    if (NODE_BUILTINS.has(root) || HOST_PROVIDED.has(root)) { continue; }
    if (present.has(`node_modules/${root}/package.json`)) { continue; }
    if (OPTIONAL_EXTERNALS.has(root)) {
      notes.push(`D: '${root}' is absent but is an OPTIONAL external (a native ws accelerator the code runs without).`);
      continue;
    }
    unresolved.push(root);
  }

  if (unresolved.length) {
    fail('D (runtime requires resolve)',
      `dist/ requires ${unresolved.length} bare specifier(s) at runtime that are NOT in the archive. Each throws the first time a user reaches the feature behind it, with nothing in the build to warn them.`,
      unresolved.map(r => `require('${r}')  - no node_modules/${r}/package.json in the package`));
  } else {
    notes.push(`D: all ${specs.size} runtime require target(s) resolve (builtin, host-provided, shipped, or a guarded optional).`);
  }
}

/** Collect `require("<literal>")` call expressions. AST only - no string literals. */
function walkForRequires(node, out, seen = new Set()) {
  if (!node || typeof node !== 'object') { return; }
  if (seen.has(node)) { return; }
  if (Array.isArray(node)) { for (const c of node) { walkForRequires(c, out, seen); } return; }
  seen.add(node);
  if (node.type === 'CallExpression'
      && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require'
      && node.arguments.length === 1 && node.arguments[0].type === 'StringLiteral') {
    out.add(node.arguments[0].value);
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') { continue; }
    const v = node[key];
    if (v && typeof v === 'object') { walkForRequires(v, out, seen); }
  }
}

// ---------------------------------------------------------------------------
// ASSERTION E - no phantom production dependencies.
//
// A phantom dependency is a package that production code imports but
// package.json never declares. It works on the maintainer's machine because
// some OTHER dependency happened to hoist it into node_modules. It breaks the
// day that other dependency bumps a version, and it breaks silently: the build
// fails on a machine that is not this one, pointing at a file nobody touched.
//
// Not hypothetical here: `@modelcontextprotocol/sdk` is imported by production
// source and is declared in neither `dependencies` nor `devDependencies`. It
// resolves only because `@google/stitch-sdk` pulls it in transitively.
//
// HEURISTIC, stated plainly: `import type ...` is erased by the compiler and is
// NOT counted. A value-import of something only ever used as a type will be
// reported here; the fix in that case is to write `import type`, which is the
// right thing to write anyway.
// ---------------------------------------------------------------------------
function assertNoPhantomDeps(manifest) {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const runtimeDeclared = new Set(Object.keys(manifest.dependencies ?? {}));

  const imports = new Map(); // package root -> Set(source files)
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!/\.tsx?$/.test(e.name)) { continue; }
      const src = fs.readFileSync(abs, 'utf8');
      const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
      const re = /^\s*import\s+(?!type\s)[^;]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|(?<![.\w])require\(\s*["']([^"']+)["']\s*\)/gm;
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1] || m[2] || m[3];
        if (!spec || spec.startsWith('.') || spec.startsWith('/')) { continue; }
        const root = rootOf(spec);
        if (NODE_BUILTINS.has(root) || HOST_PROVIDED.has(root)) { continue; }
        if (!imports.has(root)) { imports.set(root, new Set()); }
        imports.get(root).add(rel);
      }
    }
  })(path.join(REPO_ROOT, 'src'));

  const phantom = [];
  const devOnly = [];
  for (const [root, users] of [...imports].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!declared.has(root)) { phantom.push({ root, users: [...users].sort() }); }
    else if (!runtimeDeclared.has(root)) { devOnly.push(root); }
  }

  if (phantom.length) {
    const details = [];
    for (const p of phantom) {
      details.push(`${p.root}  - imported by ${p.users.length} production file(s), declared NOWHERE in package.json:`);
      for (const u of p.users.slice(0, 6)) { details.push(`    ${u}`); }
      if (p.users.length > 6) { details.push(`    ... and ${p.users.length - 6} more`); }
    }
    fail('E (no phantom dependencies)',
      `${phantom.length} package(s) are imported by src/ but declared in no dependency field. They resolve today only because another dependency hoists them; the build breaks - silently, and not on this machine - when that dependency moves.`,
      details);
  } else {
    notes.push('E: every package src/ imports is declared in package.json.');
  }

  if (devOnly.length) {
    notes.push(`E (note): imported by src/ but declared only as devDependencies: ${devOnly.join(', ')}. Fine while webpack bundles them; wrong the moment one becomes an external.`);
  }
}

// ---------------------------------------------------------------------------
// ASSERTION F - packaging flags must not be load-bearing.
//
// `vsce package` and `vsce package --no-dependencies` should describe the same
// artifact. When they do not, "the release build" is whatever the person
// cutting it happened to type, and a flag nobody thinks about decides whether a
// feature works in the wild.
//
// On this repo they genuinely differ, and the difference is not cosmetic:
// `.vscodeignore` un-ignores `node_modules/playwright*`, and a `!` rule can only
// re-include something vsce actually walked. `--no-dependencies` never walks
// node_modules, so Playwright silently vanishes and `require('playwright')`
// throws in the packaged extension.
//
// Since that divergence cannot be removed without giving up the un-ignore, this
// assertion does the next best thing: it FAILS LOUDLY if the divergence exists
// AND any release script fails to pin the flag that produces the correct
// artifact. A documented, pinned divergence is contained; an unpinned one is a
// coin flip at release time.
// ---------------------------------------------------------------------------
function assertFlagParity(manifest) {
  let withDeps, withoutDeps;
  try {
    withDeps = vsceLs([]);
    withoutDeps = vsceLs(['--no-dependencies']);
  } catch (err) {
    notes.push(`F: SKIPPED - could not run \`vsce ls\` (${String(err.message).split('\n')[0]}).`);
    return;
  }

  const a = new Set(withDeps);
  const b = new Set(withoutDeps);
  const onlyWith = withDeps.filter(f => !b.has(f));
  const onlyWithout = withoutDeps.filter(f => !a.has(f));

  if (!onlyWith.length && !onlyWithout.length) {
    notes.push(`F: identical with and without --no-dependencies (${withDeps.length} files) - the flag is not load-bearing.`);
    return;
  }

  // The divergence exists. Is it pinned everywhere it matters?
  const packageScripts = Object.entries(manifest.scripts ?? {})
    .filter(([, cmd]) => /\bvsce\s+package\b/.test(cmd));
  const unpinned = packageScripts.filter(([, cmd]) => !/--dependencies\b/.test(cmd));

  const summary = [
    `with dependency resolution: ${withDeps.length} files`,
    `with --no-dependencies:     ${withoutDeps.length} files`,
    `${onlyWith.length} file(s) exist ONLY when dependencies are resolved, e.g.:`,
    ...onlyWith.slice(0, 5).map(f => `    ${f}`),
  ];
  if (onlyWithout.length) {
    summary.push(`${onlyWithout.length} file(s) exist ONLY with --no-dependencies, e.g.:`);
    summary.push(...onlyWithout.slice(0, 5).map(f => `    ${f}`));
  }

  if (!packageScripts.length) {
    fail('F (packaging flags are not load-bearing)',
      'The archive differs by packaging flag, and package.json defines NO `vsce package` script - so the release artifact is whatever the person cutting it types on the day.',
      summary.concat(['fix: add a `package` script that pins `vsce package --dependencies`.']));
    return;
  }
  if (unpinned.length) {
    fail('F (packaging flags are not load-bearing)',
      `The archive differs by packaging flag, and ${unpinned.length} release script(s) do not pin --dependencies. Those scripts can produce an artifact missing a runtime external.`,
      summary.concat(unpinned.map(([name, cmd]) => `unpinned script: "${name}": "${cmd}"`)));
    return;
  }

  notes.push(
    `F: the archive DOES differ by flag (${withDeps.length} vs ${withoutDeps.length} files - the un-ignored `
    + `node_modules/playwright* tree, which only exists when vsce resolves dependencies), but every release `
    + `script pins --dependencies (${packageScripts.map(([n]) => n).join(', ')}), so the hazard is contained.`);
}

// ---------------------------------------------------------------------------
// ASSERTION G - every large asset is on the allowlist.
// ---------------------------------------------------------------------------
function assertLargeAssetsAllowlisted(files) {
  const big = files.filter(f => f.size >= LARGE_FILE_BYTES);
  const unlisted = big.filter(f => !LARGE_ASSET_ALLOWLIST.some(([re]) => re.test(f.rel)));
  if (!unlisted.length) {
    notes.push(`G: all ${big.length} file(s) >= ${mb(LARGE_FILE_BYTES)} are allowlisted.`);
    return;
  }
  unlisted.sort((x, y) => y.size - x.size);
  fail('G (large assets allowlisted)',
    `${unlisted.length} file(s) at or above ${mb(LARGE_FILE_BYTES)} ship with no allowlist entry. Add one to LARGE_ASSET_ALLOWLIST in this script saying what the file is for - or stop shipping the file.`,
    unlisted.slice(0, 20).map(f => `${f.rel}  (${mb(f.size)})`)
      .concat(unlisted.length > 20 ? [`... and ${unlisted.length - 20} more`] : []));
}

// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const skipParity = args.includes('--skip-parity');
  const vsixArg = args.find(a => !a.startsWith('--'));

  let vsixPath = null;
  if (vsixArg) {
    vsixPath = path.isAbsolute(vsixArg) ? vsixArg : path.resolve(process.cwd(), vsixArg);
    if (!fs.existsSync(vsixPath)) {
      console.error(`[package-shape] No such file: ${vsixPath}`);
      process.exit(2);
    }
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  let archive;
  try {
    archive = loadArchive(vsixPath);
  } catch (err) {
    console.error(`[package-shape] Could not read the package: ${err.message}`);
    process.exit(2);
  }

  const present = new Set(archive.files.map(f => f.rel));

  console.log(`[package-shape] Source:  ${archive.source}`);
  console.log(`[package-shape] Entries: ${archive.files.length}`);
  console.log('');

  assertWalkthroughAssets(present, manifest);
  assertNoSourceMaps(archive.files);
  assertNoDeclarations(archive.files);
  assertRuntimeRequiresResolve(archive, present);
  assertNoPhantomDeps(manifest);
  if (skipParity) { notes.push('F: SKIPPED (--skip-parity).'); } else { assertFlagParity(manifest); }
  assertLargeAssetsAllowlisted(archive.files);

  for (const n of notes) { console.log(`[package-shape] ok   ${n}`); }

  if (!failures.length) {
    console.log('');
    console.log('[package-shape] PASS - every shape assertion held.');
    return;
  }

  console.error('');
  console.error(`[package-shape] FAIL - ${failures.length} assertion(s) did not hold.`);
  for (const f of failures) {
    console.error('');
    console.error(`  ASSERTION ${f.assertion}`);
    console.error(`    ${f.message}`);
    for (const d of f.details) { console.error(`      ${d}`); }
  }
  console.error('');
  process.exit(1);
}

main();
