/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 §22 / lane O — the publish-review compliance items, pinned.
 *
 * Every assertion here is about a CLASS of thing that was wrong once and was
 * fixed by hand: a dead MIT bundle with its banner stripped shipped under the
 * root Apache-2.0; vendored components with no attribution; a contributor's
 * copyright folded into "All rights reserved."; research dossiers on a private
 * backend indexed from the public tree; a merged contributor uncredited; and a
 * PII quarantine that only worked by filename. None of it is caught by `tsc`,
 * `npm test` or the package-shape check, and each one regresses silently.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

// gitignore-shaped: `*` does not cross `/`, `**` does. Enough to answer "does
// any plain ignore line in .vscodeignore catch a root-level file?".
function ignoreLineMatches(pattern: string, file: string): boolean {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (ch === '*') { out += '[^/]*'; }
    else if (ch === '?') { out += '[^/]'; }
    else { out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
  }
  return new RegExp(`^${out}$`).test(file);
}

function gitIgnored(rel: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const vscodeignoreLines = () =>
  read('.vscodeignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

// ---------------------------------------------------------------------------
// O-1 — the dead fabric bundle is gone, and so is the manifest line about it.
// ---------------------------------------------------------------------------
describe('O-1: resources/fabric.min.js is not in the tree', () => {
  it('the file is deleted', () => {
    expect(exists('resources/fabric.min.js'), 'fabric.min.js is back — MIT bundle, banner stripped, loaded by nothing').toBe(false);
  });

  it('nothing under media/ or src/ loads it', () => {
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {walk(p, acc);}
        else if (/\.(html|ts|js)$/.test(ent.name)) {acc.push(p);}
      }
      return acc;
    };
    const offenders = [...walk(path.join(ROOT, 'media')), ...walk(path.join(ROOT, 'src'))]
      .filter((p) => fs.readFileSync(p, 'utf8').includes('fabric.min.js'));
    expect(offenders).toEqual([]);
  });

  it('.vscodeignore no longer carries a dead line for it, but still excludes the retained fossil', () => {
    expect(read('.vscodeignore')).not.toMatch(/fabric/);
    expect(exists('resources/mcp-permission-server.js'), 'mcp-permission-server.js is deliberately retained').toBe(true);
    expect(vscodeignoreLines()).toContain('resources/mcp-permission-server.js');
  });
});

// ---------------------------------------------------------------------------
// O-2 — NOTICE: every vendored third-party asset is attributed, from the asset.
// ---------------------------------------------------------------------------
describe('O-2: NOTICE attributes every vendored asset and ships', () => {
  const notice = () => read('NOTICE');

  it('exists at the repo root', () => {
    expect(exists('NOTICE')).toBe(true);
  });

  // Anything minified or bundled under resources/ that is not Mysti's own code.
  const MYSTI_OWN = new Set([
    'resources/canvas-sandbox/harness.js',
    'resources/canvas-sandbox/ui-primitives.js',
    'resources/mcp-permission-server.js',
  ]);
  const vendored = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {walk(p);}
        else if (/\.js$/.test(ent.name)) {
          const rel = path.relative(ROOT, p).split(path.sep).join('/');
          if (!MYSTI_OWN.has(rel)) {out.push(rel);}
        }
      }
    };
    walk(path.join(ROOT, 'resources'));
    return out.sort();
  };

  it('names every vendored .js under resources/ by path — a new bundle without an entry fails here', () => {
    const files = vendored();
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const rel of files) {
      expect(notice(), `${rel} is vendored but not attributed in NOTICE`).toContain(rel);
    }
  });

  it('every path NOTICE attributes still exists (no stale entries)', () => {
    const paths = notice().match(/resources\/[\w./-]+\.js/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const rel of new Set(paths)) {
      expect(exists(rel), `NOTICE attributes ${rel}, which is gone`).toBe(true);
    }
  });

  it('versions and copyright holders in NOTICE agree with the banners INSIDE the assets', () => {
    const n = notice();
    // Version strings read from the vendored files themselves.
    const mermaid = read('resources/mermaid.min.js');
    const marked = read('resources/marked.min.js');
    const dompurify = read('resources/dompurify.min.js');
    const react = read('resources/canvas-sandbox/react.production.min.js');
    const babel = read('resources/canvas-sandbox/babel.min.js');

    // Anchor to mermaid's OWN package metadata — the bundle embeds its
    // dependencies' `version:"…"` strings too, and the first one is not mermaid.
    const mermaidV = /name:"mermaid",version:"(\d+\.\d+\.\d+)"/.exec(mermaid)?.[1];
    const markedV = /marked v(\d+\.\d+\.\d+)/.exec(marked)?.[1];
    const dompurifyV = /DOMPurify (\d+\.\d+\.\d+)/.exec(dompurify)?.[1];
    const reactV = /"(18\.\d+\.\d+)"/.exec(react)?.[1];
    expect(mermaidV && markedV && dompurifyV && reactV).toBeTruthy();

    expect(n).toContain(`Mermaid ${mermaidV}`);
    expect(n).toContain(`Marked ${markedV}`);
    expect(n).toContain(`DOMPurify ${dompurifyV}`);
    expect(n).toContain(`React ${reactV}`);
    expect(n).toContain(`React DOM ${reactV}`);
    // @babel/standalone has no banner; the version NOTICE claims must at least be a
    // string present in the bundle.
    const babelV = /@babel\/standalone (\d+\.\d+\.\d+)/.exec(n)?.[1];
    expect(babelV, 'NOTICE must name the @babel/standalone version').toBeTruthy();
    expect(babel).toContain(`"${babelV}"`);

    // Holders, as the banners state them.
    expect(marked).toContain('Christopher Jeffrey');
    expect(n).toContain('Christopher Jeffrey');
    expect(dompurify).toContain('Cure53');
    expect(n).toContain('Cure53');
    expect(react).toContain('Facebook, Inc. and its affiliates');
    expect(n).toContain('Facebook, Inc. and its affiliates');
    // Those with no in-file holder are attributed from the upstream LICENSE.
    expect(n).toContain('Knut Sveidqvist'); // mermaid
    expect(n).toContain('Lea Verou'); // prism
    expect(n).toContain('Sebastian McKenzie'); // babel
    // DOMPurify is dual-licensed; saying "MIT" for it would be a false statement.
    expect(n).toMatch(/DOMPurify[\s\S]{0,400}Apache License 2\.0 and Mozilla Public License 2\.0/);
  });

  it('carries the trademark carve-out and names every vendor logo under resources/icons/', () => {
    const n = notice();
    expect(n).toMatch(/[Tt]rademark/);
    expect(n).toMatch(/respective owners/);
    expect(n).toMatch(/nominative/i);
    // Provider logos = the icon files the provider manifest points at, plus the
    // sibling variants of the same marks.
    const manifest = read('src/providers/base/ProviderManifest.ts');
    const fromManifest = [...manifest.matchAll(/icon: 'icons\/([^']+)'/g)].map((m) => m[1]);
    expect(fromManifest.length).toBeGreaterThanOrEqual(15);
    for (const f of fromManifest) {
      expect(n, `provider logo ${f} is not named in the NOTICE trademark section`).toContain(`resources/icons/${f}`);
    }
  });

  it('is not excluded from the VSIX by any .vscodeignore line', () => {
    for (const line of vscodeignoreLines()) {
      if (line.startsWith('!')) {continue;}
      expect(ignoreLineMatches(line, 'NOTICE'), `.vscodeignore line "${line}" would drop NOTICE from the package`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// O-3 — contributor-authored files carry the contributor's copyright.
// ---------------------------------------------------------------------------
describe('O-3: MostlyK-authored provider headers', () => {
  for (const rel of ['src/providers/cline/ClineProvider.ts', 'src/providers/cursor/CursorProvider.ts']) {
    it(`${rel} names both copyright holders in its header`, () => {
      const header = read(rel).split('\n').slice(0, 14).join('\n');
      expect(header).toContain('Copyright (c) 2025 DeepMyst Inc.');
      expect(header).toContain('Author: MostlyK');
      expect(header).toMatch(/Portions copyright \(c\) 20\d\d MostlyK/);
      expect(header).toContain('SPDX-License-Identifier: Apache-2.0');
    });
  }
});

// ---------------------------------------------------------------------------
// O-4 — the private-backend dossiers are gone and nothing indexes them.
// ---------------------------------------------------------------------------
describe('O-4: DeepMyst-2.0 research dossiers are out of the tree', () => {
  const DOSSIERS = ['deepmyst-mcp-connections.md', 'deepmyst-presentation-canvas.md'];
  const MARKER = '(internal research dossier — removed from the public tree 2026-09-05)';
  // Files whose references were outside lane O and were handed off. When a
  // handoff lands, the "not stale" assertion below fails, telling you to delete
  // the entry. Do not add to this list to make the test pass.
  //
  // plans/05-canvas-overhaul.md: DISCHARGED 2026-09-05 — its three references
  // (one /tmp planning path, two repo-relative) now carry the marker, so every
  // plan file is covered by the assertion above and this set is empty.
  const PENDING_HANDOFF = new Set<string>([]);

  const planFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {walk(p);}
        else if (ent.name.endsWith('.md')) {out.push(path.relative(ROOT, p).split(path.sep).join('/'));}
      }
    };
    walk(path.join(ROOT, 'plans'));
    return out;
  };

  for (const d of DOSSIERS) {
    it(`plans/research/${d} is deleted`, () => {
      expect(exists(`plans/research/${d}`)).toBe(false);
    });
  }

  it('no plan (outside the pending handoff) references them except via the removal marker', () => {
    for (const rel of planFiles()) {
      if (PENDING_HANDOFF.has(rel)) {continue;}
      const lines = read(rel).split('\n');
      lines.forEach((line, i) => {
        for (const d of DOSSIERS) {
          if (line.includes(d)) {
            expect(line, `${rel}:${i + 1} references ${d} without the removal marker`).toContain(MARKER);
          }
        }
      });
    }
  });

  it('the pending-handoff list is not stale', () => {
    for (const rel of PENDING_HANDOFF) {
      const text = read(rel);
      const still = DOSSIERS.some((d) => text.split('\n').some((l) => l.includes(d) && !l.includes(MARKER)));
      expect(still, `${rel} no longer references the dossiers — remove it from PENDING_HANDOFF`).toBe(true);
    }
  });

  it('plans/README.md and plans/04 carry the marker where the citations were', () => {
    expect(read('plans/README.md')).toContain(MARKER);
    expect(read('plans/04-connections-and-agent-management.md')).toContain(MARKER);
  });
});

// ---------------------------------------------------------------------------
// O-5 — 3em0 is credited: the only external author of a merged security fix.
// ---------------------------------------------------------------------------
describe('O-5: 3em0 is credited', () => {
  it('README contributor strip links their profile', () => {
    const readme = read('README.md');
    const start = readme.indexOf('## Contributors');
    const end = readme.indexOf('## ', start + 5);
    expect(start).toBeGreaterThan(-1);
    const strip = readme.slice(start, end);
    expect(strip).toContain('href="https://github.com/3em0"');
    expect(strip).toContain('alt="3em0"');
  });

  it('CHANGELOG [0.5.1] thanks them by PR number, including the re-landed ones', () => {
    const cl = read('CHANGELOG.md');
    const start = cl.indexOf('## [0.5.1]');
    const end = cl.indexOf('## [0.4.0]');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toContain('3em0');
    for (const pr of ['#43', '#45', '#47', '#48', '#49']) {
      expect(section, `CHANGELOG [0.5.1] thanks must cite ${pr}`).toContain(pr);
    }
  });
});

// ---------------------------------------------------------------------------
// O-6 — stargazer exports are quarantined by DIRECTORY, not by filename.
// ---------------------------------------------------------------------------
describe('O-6: .gitignore quarantines a stargazers/ directory', () => {
  it('has the directory rule', () => {
    const lines = read('.gitignore').split('\n').map((l) => l.trim());
    expect(lines).toContain('stargazers/');
  });

  it('a future export with an unpatterned name is ignored when it lives there (git check-ignore)', () => {
    expect(gitIgnored('stargazers/gh-users.csv')).toBe(true);
    expect(gitIgnored('stargazers/anything/at/all.json')).toBe(true);
    // ...and the same file at the root is NOT — which is the whole point of
    // the directory rule and the comment telling exports where to live.
    expect(gitIgnored('gh-users.csv')).toBe(false);
  });

  it('the existing loose artifacts stay ignored', () => {
    for (const rel of [
      'Mysti stargazers.xlsx',
      'stargazers-export.xlsx',
      'stargazers-cline-cline.xlsx',
      '.stargazers-cache-openclaw-openclaw.ndjson',
      '.stargazers-cache-cline-cline.json.backup',
      'fetch-stargazers.log',
      'scripts/fetch-stargazers.js',
      'scripts/export-cache.js',
    ]) {
      expect(gitIgnored(rel), `${rel} is no longer ignored`).toBe(true);
    }
  });
});
