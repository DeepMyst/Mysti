import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import type { DeskScopeSpec } from '../types';
import { DeskIndex } from './desk/DeskIndex';
import { isInScope, resolveScope } from './desk/DeskScope';
import { validatePath } from './desk/DeskContract';

/** Immutable coordinates prepared by the owner, never a remote file reader. */
export interface DeskLookupSnapshot {
  scope: DeskScopeSpec;
  index: DeskIndex;
  isCurrent(): Promise<boolean>;
}

export interface DeskWorkspaceLookupOptions {
  root: string;
  /** Read from the machine/user setting, never a workspace override. */
  ceiling(): unknown;
  active(): boolean;
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala|c|h|cc|cpp|hpp|m|mm)$/i;
const EXCLUDED = /^(?:node_modules|dist|build|out|out-test|coverage|vendor|__pycache__|library|appdata|credentials?|secrets?|tokens?|sessions?|transcripts?|chat[_-]?history|private[_-]?keys?|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|[._-])/i;
const PRIVATE_EXTENSION = /\.(?:pem|key|p12|pfx|keystore|db|sqlite\d*|log|jsonl)$/i;
const MAX_FILE = 512 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_FILES = 1024;
const MAX_DEPTH = 24;
const MAX_BUILD_MS = 10_000;
const CONFIG = '.mysti/desk-share.json';

function eligible(relative: string): boolean {
  return validatePath(relative, 'path').ok && !PRIVATE_EXTENSION.test(relative)
    && relative.split('/').every(part => !part.startsWith('.') && !EXCLUDED.test(part));
}

function fingerprint(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

/**
 * Privileged adapter outside the sealed dispatcher. Only an explicit local
 * sharing command builds an index. Requests can validate that snapshot, but
 * cannot select a root, trigger a crawl, or read source text.
 */
export class DeskWorkspaceLookup {
  constructor(private readonly _options: DeskWorkspaceLookupOptions) {}

  async prepare(grantScope: string[], live: () => boolean): Promise<DeskLookupSnapshot> {
    const root = path.resolve(this._options.root);
    const started = Date.now();
    let preparing = true;
    const check = () => {
      if (!live() || !this._options.active() || (preparing && Date.now() - started > MAX_BUILD_MS)) {
        throw new Error('Desk workspace snapshot unavailable');
      }
    };
    check();
    // A profile/store or filesystem root is never a shareable workspace.
    if (!path.isAbsolute(this._options.root) || root === path.parse(root).root || root === os.homedir()
      || root.split(path.sep).filter(Boolean).some(part => part.startsWith('.') || EXCLUDED.test(part))) {
      throw new Error('Desk workspace root unavailable');
    }
    const canonical = await fs.promises.realpath(root);
    // Permit OS aliases in ancestors (e.g. /tmp on macOS), but never a linked
    // workspace root, nor an alias into a hidden/profile store.
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || canonical.toLowerCase() === os.homedir().toLowerCase()
      || canonical.split(path.sep).filter(Boolean).some(part => part.startsWith('.') || EXCLUDED.test(part))) {
      throw new Error('Desk workspace root unavailable');
    }
    const rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
    const active = async () => {
      if (!live() || !this._options.active()) { return false; }
      try {
        const current = await fs.promises.lstat(root);
        return current.isDirectory() && !current.isSymbolicLink()
          && `${current.dev}:${current.ino}` === rootIdentity && await fs.promises.realpath(root) === canonical;
      } catch { return false; }
    };

    // Check every component; never follow a symlink/junction or hard-linked file.
    const inspect = async (relative: string): Promise<fs.Stats> => {
      if (!await active()) { throw new Error('Desk workspace changed'); }
      const parts = relative.split('/');
      let target = canonical;
      let stat = rootStat;
      for (let i = 0; i < parts.length; i++) {
        target = path.join(target, parts[i]);
        stat = await fs.promises.lstat(target);
        if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) {
          throw new Error('Desk workspace link refused');
        }
      }
      if (await fs.promises.realpath(target) !== target || (stat.isFile() && stat.nlink !== 1)) {
        throw new Error('Desk workspace link refused');
      }
      return stat;
    };
    const read = async (relative: string, limit: number): Promise<string> => {
      check();
      const before = await inspect(relative);
      if (!before.isFile() || before.size > limit) { throw new Error('Desk workspace file unavailable'); }
      const target = path.join(canonical, ...relative.split('/'));
      const handle = await fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        // Pin the descriptor to the inspected regular file before reading any
        // bytes. Recheck the entire parent chain and the open descriptor too.
        const opened = await handle.stat();
        if (!opened.isFile() || fingerprint(opened) !== fingerprint(before)
          || fingerprint(await inspect(relative)) !== fingerprint(before)) { throw new Error('Desk workspace changed'); }
        check();
        const buffer = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) { break; }
          length += bytesRead;
          check();
        }
        if (length > limit || fingerprint(await handle.stat()) !== fingerprint(before)
          || fingerprint(await inspect(relative)) !== fingerprint(before)) { throw new Error('Desk workspace changed'); }
        return buffer.subarray(0, length).toString('utf8');
      } finally { await handle.close(); }
    };
    const peerScope = [...grantScope];
    const resolve = async (): Promise<DeskScopeSpec> => {
      const ceiling = this._options.ceiling();
      if (!Array.isArray(ceiling) || ceiling.length === 0 || ceiling.length > 128 || peerScope.length > 128) {
        throw new Error('Configure Desk share ceiling first');
      }
      const raw = await read(CONFIG, 16 * 1024);
      const share: unknown = JSON.parse(raw);
      if (!share || typeof share !== 'object' || Array.isArray(share)) { throw new Error('Invalid Desk share file'); }
      const spec = share as { allow?: unknown; version?: unknown };
      if (!Array.isArray(spec.allow) || spec.allow.length > 128) { throw new Error('Invalid Desk share file'); }
      const workspace = resolveScope({ ceiling, share: spec });
      const scope = resolveScope({ ceiling: workspace.allow, share: { allow: peerScope } });
      if (!scope.allow.length) { throw new Error('Desk shared scope is empty'); }
      // Hash structured fields: punctuation in legal paths cannot collide with
      // the delimiter used by the pure resolver's human-readable version.
      scope.scopeVersion = createHash('sha256').update(JSON.stringify([ceiling, raw,
        fingerprint(await inspect(CONFIG)), peerScope, scope.allow])).digest('hex');
      return scope;
    };
    const scope = await resolve();
    if (!scope.allow.length) { throw new Error('Desk shared scope is empty'); }
    const observed = new Map<string, string>();
    const texts = new Map<string, string>();
    const paths: string[] = [];
    let entries = 0, bytes = 0;
    const walk = async (relative: string, depth: number): Promise<void> => {
      check();
      if (depth > MAX_DEPTH) { throw new Error('Desk workspace limit exceeded'); }
      const stat = relative ? await inspect(relative) : await fs.promises.lstat(canonical);
      observed.set(relative, fingerprint(stat));
      const directory = await fs.promises.opendir(path.join(canonical, ...relative.split('/').filter(Boolean)));
      for await (const entry of directory) {
        check();
        if (++entries > MAX_ENTRIES) { throw new Error('Desk workspace limit exceeded'); }
        const candidate = relative ? `${relative}/${entry.name}` : entry.name;
        if (!eligible(candidate)) { continue; }
        // Ancestors may be traversed, but their other descendants are not read.
        const within = isInScope(scope, candidate);
        const ancestor = scope.allow.some(prefix => prefix.startsWith(candidate + '/'));
        if (!within && !ancestor) { continue; }
        // Links and non-regular files are outside the shareable file set.
        if (entry.isSymbolicLink()) { continue; }
        if (entry.isDirectory()) { await walk(candidate, depth + 1); continue; }
        if (!within || !entry.isFile()) { continue; }
        const file = await inspect(candidate);
        if (!file.isFile()) { throw new Error('Desk workspace changed'); }
        if (paths.length >= MAX_FILES) { throw new Error('Desk workspace limit exceeded'); }
        paths.push(candidate);
        observed.set(candidate, fingerprint(file));
        if (SOURCE.test(candidate)) {
          bytes += file.size;
          if (bytes > MAX_BYTES) { throw new Error('Desk workspace limit exceeded'); }
          const text = await read(candidate, MAX_FILE);
          if (!text.includes('\0')) { texts.set(candidate, text); }
        }
      }
    };
    await walk('', 0);
    const index = DeskIndex.build(scope, { paths: paths.sort(), readText: name => texts.get(name) ?? null });
    texts.clear(); // Retain coordinates only, never source text in the session.
    check();
    preparing = false;
    let invalidated = false;
    const isCurrent = async (): Promise<boolean> => {
      try {
        if (invalidated || !await active() || (await resolve()).scopeVersion !== scope.scopeVersion) {
          invalidated = true; return false;
        }
        for (const [relative, expected] of observed) {
          const stat = relative ? await inspect(relative) : await fs.promises.lstat(canonical);
          if (fingerprint(stat) !== expected) { invalidated = true; return false; }
        }
        // Permission edits during the metadata walk must also invalidate this
        // response. The caller rechecks session authority after this await.
        if (!await active() || (await resolve()).scopeVersion !== scope.scopeVersion) { invalidated = true; }
        return !invalidated;
      } catch { invalidated = true; return false; }
    };
    if (!await isCurrent()) { throw new Error('Desk workspace changed while indexing'); }
    return { scope, index, isCurrent };
  }
}
