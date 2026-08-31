/**
 * Desk import-graph test (Plan 21 Phase 1, invariant I11).
 *
 * THIS IS THE SECURITY CLAIM.
 *
 * Everything else in Plan 21 argues that a remote request cannot write a file,
 * spawn a process, or reach the network. This test is what makes that argument
 * checkable: it walks the TRANSITIVE import graph reachable from the Desk
 * dispatcher and fails if a forbidden capability appears anywhere in it.
 *
 * The value is that it does not depend on reviewing intent. A future edit that
 * imports `MystiLocalExec` "just to reuse a helper" fails here, in CI, with the
 * exact chain printed — rather than being caught by whoever happens to read
 * the diff.
 *
 * Deliberately implemented by SOURCE SCANNING rather than by mocking: a mock
 * proves what a module does when called, and the claim here is about what it
 * can reach at all.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');

/**
 * Modules and node builtins a serving path must never be able to reach.
 * Each entry is matched against the resolved import specifier.
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /(^|\/)MystiLocalExec$/, why: 'local write/edit/patch/bash execution' },
  { pattern: /(^|\/)MystiSandbox$/, why: 'sandboxed shell execution' },
  { pattern: /(^|\/)CollaboratorPool$/, why: 'spawns provider children, and carries a web-request carve-out' },
  { pattern: /(^|\/)McpClient$/, why: 'outbound network to MCP servers' },
  { pattern: /(^|\/)McpConfigManager$/, why: 'writes credentials into CLI config files' },
  { pattern: /(^|\/)DevServerManager$/, why: 'spawns a dev server (shell: true)' },
  { pattern: /(^|\/)BrowserManager$/, why: 'drives a real browser' },
  { pattern: /(^|\/)CheckpointManager$/, why: 'runs git subprocesses' },
  { pattern: /^child_process$/, why: 'process spawning' },
  { pattern: /^node:child_process$/, why: 'process spawning' },
  { pattern: /^node:worker_threads$/, why: 'thread spawning' },
  { pattern: /^worker_threads$/, why: 'thread spawning' },
  { pattern: /^node:http$|^http$/, why: 'outbound network' },
  { pattern: /^node:https$|^https$/, why: 'outbound network' },
  { pattern: /^node:net$|^net$/, why: 'raw sockets' },
  { pattern: /^ws$/, why: 'websockets' },
  { pattern: /^vscode$/, why: 'editor API — the dispatcher must stay pure and testable without it' },
];

/** Write-capable fs calls. Reading is fine; mutating the disk is not. */
const FS_WRITE_CALL_RE =
  /\bfs(?:\.promises)?\s*\.\s*(writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|mkdir|mkdirSync|rename|renameSync|copyFile|copyFileSync|chmod|chmodSync|createWriteStream|truncate|truncateSync)\b/;

/** Resolve a relative import specifier to an absolute .ts file, if it exists. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) { return null; }
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { return candidate; }
  }
  return null;
}

/**
 * Every RUNTIME import specifier in a source file.
 *
 * `import type ... from 'x'` and `export type ... from 'x'` are excluded, and
 * this distinction is load-bearing rather than a convenience: TypeScript erases
 * a type-only import entirely, so it creates no runtime edge and cannot reach a
 * capability. Counting them would make this test fire on
 * `DeskScope → types.ts → IProvider.ts → vscode` — a chain that does not exist
 * in the emitted JavaScript — and a security test that cries wolf is one people
 * learn to skip.
 *
 * The inline form `import { type A, B }` is deliberately treated as a runtime
 * edge: `B` is a value. So is a plain `import { X }` used only as a type, which
 * TypeScript would elide — proving that statically needs the type checker, and
 * over-reporting there fails safe.
 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // `(?!\s*type\s)` rejects the type-only form without consuming the keyword.
  const staticRe = /(?:^|\n)\s*(?:import|export)(?!\s+type\s)\s[^;]*?from\s*['"]([^'"]+)['"]/g;
  const bareRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, bareRe, dynamicRe, requireRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) { specs.push(m[1]); }
  }
  return specs;
}

interface GraphResult {
  visited: string[];
  violations: { chain: string[]; specifier: string; why: string }[];
  fsWrites: string[];
}

/** Walk the transitive import graph from an entry file. */
function walk(entry: string): GraphResult {
  const visited = new Set<string>();
  const violations: GraphResult['violations'] = [];
  const fsWrites: string[] = [];
  const queue: { file: string; chain: string[] }[] = [{ file: entry, chain: [entry] }];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (visited.has(file)) { continue; }
    visited.add(file);

    const source = fs.readFileSync(file, 'utf8');

    if (FS_WRITE_CALL_RE.test(source)) {
      fsWrites.push(path.relative(ROOT, file));
    }

    for (const spec of importSpecifiers(source)) {
      const forbidden = FORBIDDEN.find(f => f.pattern.test(spec));
      if (forbidden) {
        violations.push({
          chain: chain.map(c => path.relative(ROOT, c)),
          specifier: spec,
          why: forbidden.why,
        });
        continue;
      }
      const resolved = resolveLocal(file, spec);
      if (resolved && !visited.has(resolved)) {
        queue.push({ file: resolved, chain: [...chain, resolved] });
      }
    }
  }

  return { visited: [...visited].map(f => path.relative(ROOT, f)), violations, fsWrites };
}

const DESK_DIR = path.join(SRC, 'services', 'desk');

describe('Desk import graph (invariant I11)', () => {
  const entries = fs.existsSync(DESK_DIR)
    ? fs.readdirSync(DESK_DIR).filter(f => f.endsWith('.ts')).map(f => path.join(DESK_DIR, f))
    : [];

  it('has Desk modules to check (guards against the suite silently passing on an empty dir)', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const entry of entries) {
    const name = path.basename(entry);

    it(`${name} reaches no forbidden capability, transitively`, () => {
      const { violations } = walk(entry);
      const report = violations
        .map(v => `  ${v.specifier} (${v.why})\n    via ${v.chain.join('\n      → ')}`)
        .join('\n');
      expect(violations, `Forbidden imports reachable from ${name}:\n${report}`).toHaveLength(0);
    });

    it(`${name} reaches no filesystem-writing call, transitively`, () => {
      const { fsWrites } = walk(entry);
      expect(fsWrites, `fs write calls reachable from ${name}: ${fsWrites.join(', ')}`).toHaveLength(0);
    });
  }

  it('the dispatcher specifically cannot reach exec, network, or the editor API', () => {
    const dispatcher = path.join(DESK_DIR, 'DeskDispatch.ts');
    expect(fs.existsSync(dispatcher)).toBe(true);
    const { violations, visited } = walk(dispatcher);
    expect(violations).toHaveLength(0);
    // Sanity: the walk actually traversed something, so a passing result is
    // not the artefact of a broken resolver.
    expect(visited.length).toBeGreaterThan(1);
  });

  it('detects a forbidden import when one is present (the test can actually fail)', () => {
    // Self-check against a fixture rather than trusting the negative result
    // above: a scanner that never fires is indistinguishable from a clean tree.
    const tmp = path.join(DESK_DIR, '__importGraphProbe.ts');
    try {
      fs.writeFileSync(tmp, "import { spawn } from 'child_process';\nexport const x = spawn;\n", 'utf8');
      const { violations } = walk(tmp);
      expect(violations).toHaveLength(1);
      expect(violations[0].specifier).toBe('child_process');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('detects a forbidden capability reached INDIRECTLY, not just at depth 1', () => {
    // The claim is about the transitive graph, so prove the walk actually
    // traverses rather than only inspecting the entry file.
    const leaf = path.join(DESK_DIR, '__probeLeaf.ts');
    const mid = path.join(DESK_DIR, '__probeMid.ts');
    try {
      fs.writeFileSync(leaf, "import { spawn } from 'child_process';\nexport const run = spawn;\n", 'utf8');
      fs.writeFileSync(mid, "import { run } from './__probeLeaf';\nexport const go = run;\n", 'utf8');
      const { violations } = walk(mid);
      expect(violations).toHaveLength(1);
      expect(violations[0].chain.length).toBeGreaterThan(1);
    } finally {
      fs.rmSync(leaf, { force: true });
      fs.rmSync(mid, { force: true });
    }
  });

  it('does NOT fire on a type-only import, which is erased at compile time', () => {
    const tmp = path.join(DESK_DIR, '__probeTypeOnly.ts');
    try {
      fs.writeFileSync(tmp, "import type { ChildProcess } from 'child_process';\nexport type P = ChildProcess;\n", 'utf8');
      expect(walk(tmp).violations).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
