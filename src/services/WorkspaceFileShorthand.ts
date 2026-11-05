import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExpectedWorkspaceFileIdentity } from './WorkspaceFileMention';

export interface WorkspaceFileShorthandToken {
  visiblePath: string;
  quoted: boolean;
  suppliedPath: string;
}

export type WorkspaceFileShorthandResult =
  | { kind: 'unique'; selectedPath: string; expected: ExpectedWorkspaceFileIdentity }
  | { kind: 'ambiguous' | 'incomplete' | 'unavailable'; reason: string };

const RESULT_LIMIT = 257; // 256 candidates plus a truncation sentinel.
const DEADLINE_MS = 5000;
const EXCLUDE = '**/node_modules/**';
const INCOMPLETE = 'Could not verify a unique file within the workspace search limit. Choose a file using its quoted full path.';
const UNAVAILABLE = 'This file reference is no longer available. Select the file again using its quoted full path.';
const AMBIGUOUS = 'More than one current workspace file matches this reference. Choose a file using its quoted full path.';

class ResolutionFailure extends Error {
  constructor(readonly kind: 'incomplete' | 'unavailable', message: string) { super(message); }
}

function normalize(value: string): string { return value.replace(/\\/g, '/').replace(/^\.\//, ''); }
function matches(candidate: string, visible: string): boolean {
  return candidate === visible || candidate.endsWith('/' + visible);
}
function same(a: fs.BigIntStats, b: fs.BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function basenamePattern(basename: string, fold: boolean): string {
  // Bracket literals preserve glob punctuation. A leading wildcard also covers
  // POSIX literal-backslash names that the existing UI normalizes as separators.
  return '**/*' + Array.from(basename, char => {
    if (fold && /[a-z]/i.test(char)) {
      // The UI compares with toLowerCase(): Kelvin sign also lowercases to k.
      // Include that preimage so a selective query cannot hide an ambiguity.
      return char.toLowerCase() === 'k' ? '[kKK]' : `[${char.toLowerCase()}${char.toUpperCase()}]`;
    }
    return '*?[]{}'.includes(char) ? `[${char}]` : char;
  }).join('');
}

/**
 * Metadata-only uniqueness within the editor's searchable-file catalogue,
 * under its current ignore/symlink settings (the same exclusion as the UI).
 * This is not an exhaustive or atomic physical-filesystem namespace snapshot.
 * The token must be derived by host lexical validation, never by displayName.
 */
export async function resolveWorkspaceFileShorthand(
  token: WorkspaceFileShorthandToken,
  workspaceRoots: readonly string[],
  isCancelled: () => boolean = () => false
): Promise<WorkspaceFileShorthandResult | undefined> {
  if (isCancelled()) { return undefined; }
  const cancelled = Symbol('cancelled shorthand');
  const source = new vscode.CancellationTokenSource();
  const started = performance.now();
  let configurationChanged = false;
  let stopped = false;
  let rejectStop!: (reason: unknown) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  // A cancellation can happen between awaits; retain a handler even then.
  void stop.catch(() => undefined);
  const check = () => {
    if (isCancelled()) { throw cancelled; }
    if (configurationChanged || performance.now() - started >= DEADLINE_MS) {
      throw new ResolutionFailure('incomplete', INCOMPLETE);
    }
  };
  const pulse = () => {
    if (stopped) { return; }
    try { check(); } catch (error) { stopped = true; source.cancel(); rejectStop(error); }
  };
  const timer = setInterval(pulse, 20);
  const configuration = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('search') || event.affectsConfiguration('files.exclude')) {
      configurationChanged = true; pulse();
    }
  });
  const checked = async <T>(operation: () => PromiseLike<T>): Promise<T> => {
    check();
    const value = await Promise.race([Promise.resolve(operation()), stop]);
    check();
    return value;
  };
  try {
    if (!token || typeof token.visiblePath !== 'string' || !token.visiblePath || token.visiblePath.includes('\0')
      || typeof token.suppliedPath !== 'string' || !token.suppliedPath || token.suppliedPath.includes('\0')
      || typeof token.quoted !== 'boolean' || (!token.quoted && !/^[\w\-./]+$/.test(token.visiblePath))
      || !workspaceRoots.length) {
      throw new ResolutionFailure('unavailable', UNAVAILABLE);
    }
    const declared = workspaceRoots.map(root => path.resolve(root));
    const roots: Array<{ declared: string; canonical: string; identity: fs.BigIntStats }> = [];
    for (const root of declared) {
      const canonical = await checked(() => fs.promises.realpath(root));
      const identity = await checked(() => fs.promises.lstat(canonical, { bigint: true }));
      if (!identity.isDirectory()) { throw new ResolutionFailure('incomplete', INCOMPLETE); }
      roots.push({ declared: root, canonical, identity });
    }
    const suppliedAbsolute = path.isAbsolute(token.suppliedPath);
    let selected: string | undefined;
    let selectedIdentity: fs.BigIntStats | undefined;
    if (suppliedAbsolute) {
      selected = await checked(() => fs.promises.realpath(token.suppliedPath));
      selectedIdentity = await checked(() => fs.promises.lstat(selected!, { bigint: true }));
      if (!selectedIdentity.isFile() || !roots.some(root => inside(root.canonical, selected!))) {
        throw new ResolutionFailure('unavailable', UNAVAILABLE);
      }
    }
    const visible = normalize(token.visiblePath);
    if (!matches(normalize(token.suppliedPath), visible)
      && (token.quoted || !matches(normalize(token.suppliedPath).toLowerCase(), visible.toLowerCase()))) {
      throw new ResolutionFailure('unavailable', UNAVAILABLE);
    }
    const basename = visible.slice(visible.lastIndexOf('/') + 1);
    if (!basename) { throw new ResolutionFailure('unavailable', UNAVAILABLE); }
    const candidates = async (fold: boolean): Promise<Map<string, fs.BigIntStats>> => {
      const found = await checked(() => vscode.workspace.findFiles(basenamePattern(basename, fold), EXCLUDE, RESULT_LIMIT, source.token));
      // Count the raw query result, before filtering or alias deduplication.
      if (found.length >= RESULT_LIMIT) { throw new ResolutionFailure('incomplete', INCOMPLETE); }
      const result = new Map<string, fs.BigIntStats>();
      for (const uri of found) {
        check();
        if (uri.scheme !== 'file') { throw new ResolutionFailure('incomplete', INCOMPLETE); }
        const lexical = normalize(uri.fsPath);
        if (!matches(fold ? lexical.toLowerCase() : lexical, fold ? visible.toLowerCase() : visible)) { continue; }
        const canonical = await checked(() => fs.promises.realpath(uri.fsPath));
        if (!roots.some(root => inside(root.canonical, canonical))) { continue; }
        const identity = await checked(() => fs.promises.lstat(canonical, { bigint: true }));
        if (identity.isFile()) { result.set(canonical, identity); }
      }
      return result;
    };
    let found = await candidates(false);
    if (!found.size && !token.quoted) { found = await candidates(true); }
    // Revalidate roots and the selected alias after every search phase, even on
    // an apparent match. The final reader also checks this expected identity.
    for (const root of roots) {
      const canonical = await checked(() => fs.promises.realpath(root.declared));
      const identity = await checked(() => fs.promises.lstat(root.canonical, { bigint: true }));
      if (canonical !== root.canonical || !identity.isDirectory() || !same(identity, root.identity)) {
        throw new ResolutionFailure('incomplete', INCOMPLETE);
      }
    }
    if (found.size > 1) { return { kind: 'ambiguous', reason: AMBIGUOUS }; }
    if (!suppliedAbsolute) {
      // Legacy relative metadata has no selected absolute spelling. Resolve a
      // sole canonical target deterministically, never by root-array order.
      [selected, selectedIdentity] = found.entries().next().value ?? [];
    }
    if (!selected || !selectedIdentity) { throw new ResolutionFailure('unavailable', UNAVAILABLE); }
    const selectedPath = suppliedAbsolute ? token.suppliedPath : selected;
    const selectedNow = await checked(() => fs.promises.realpath(selectedPath));
    const canonicalSelected = selected;
    const identityNow = await checked(() => fs.promises.lstat(canonicalSelected, { bigint: true }));
    if (selectedNow !== selected || !identityNow.isFile() || !same(identityNow, selectedIdentity)) {
      throw new ResolutionFailure('unavailable', UNAVAILABLE);
    }
    const sole = found.get(selected);
    if (!sole || !same(sole, selectedIdentity)) { throw new ResolutionFailure('unavailable', UNAVAILABLE); }
    return { kind: 'unique', selectedPath, expected: { canonicalPath: selected, dev: sole.dev, ino: sole.ino } };
  } catch (error) {
    if (error === cancelled || isCancelled()) { return undefined; }
    if (error instanceof ResolutionFailure) { return { kind: error.kind, reason: error.message }; }
    return { kind: 'incomplete', reason: INCOMPLETE };
  } finally {
    stopped = true;
    clearInterval(timer);
    configuration.dispose();
    source.cancel();
    source.dispose();
  }
}
