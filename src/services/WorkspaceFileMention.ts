import * as fs from 'fs';
import * as path from 'path';
import type { FileHandle } from 'fs/promises';

interface WorkspaceRoot {
  declared: string;
  canonical: string;
  identity: fs.BigIntStats;
}

export interface ExpectedWorkspaceFileIdentity {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
}

export const MAX_FILE_MENTION_BYTES = 5_000_000;
const READ_CHUNK_BYTES = 64 * 1024;

/** Only these content-policy failures are safe to explain directly in chat. */
export class WorkspaceFileMentionContentError extends Error {
  constructor(readonly kind: 'binary' | 'too-large') {
    super(kind === 'binary'
      ? 'File appears binary (contains a NUL byte). Mention a text file or add a text excerpt instead.'
      : 'File exceeds the 5,000,000-byte limit for file mentions. Mention a smaller text file or add a text excerpt instead.');
    this.name = 'WorkspaceFileMentionContentError';
  }
}

function sameIdentity(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * Read a regular file physically within a declared workspace through one owned
 * handle. The selected lexical path remains the context label. Revalidation
 * detects observed retargeting; portable path APIs do not make ancestor changes
 * atomic. Text mentions reject NUL bytes and enforce a per-file raw-byte limit;
 * attachments and aggregate context budgeting use their own handling.
 */
export async function readWorkspaceFileMention(
  filePath: string,
  workspaceRoots: readonly string[],
  isCancelled: () => boolean = () => false,
  expected?: ExpectedWorkspaceFileIdentity
): Promise<{ path: string; content: string } | undefined> {
  const cancelled = Symbol('cancelled file mention');
  const check = () => { if (isCancelled()) { throw cancelled; } };
  const checked = async <T>(pending: Promise<T>): Promise<T> => {
    const value = await pending;
    check();
    return value;
  };
  try {
    check();
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
      throw new Error('Invalid file mention path.');
    }
    // Capture root strings before the first await; later array mutations cannot
    // silently change which workspace authorized this request.
    const declared = workspaceRoots.map(root => path.resolve(root));
    if (!declared.length) { throw new Error('Open a workspace folder before mentioning a file.'); }
    const selected = path.isAbsolute(filePath) ? filePath : path.resolve(declared[0], filePath);
    const roots: WorkspaceRoot[] = [];
    for (const root of declared) {
      try {
        const canonical = await checked(fs.promises.realpath(root));
        const identity = await checked(fs.promises.lstat(canonical, { bigint: true }));
        if (identity.isDirectory()) { roots.push({ declared: root, canonical, identity }); }
      } catch (error) {
        check();
        if (error === cancelled) { throw error; }
        // One unavailable root does not invalidate another declared workspace.
      }
    }
    const canonical = await checked(fs.promises.realpath(selected));
    const root = roots.find(candidate => inside(candidate.canonical, canonical));
    if (!root) { throw new Error('File mention is outside the current workspace folders.'); }
    const identity = await checked(fs.promises.lstat(canonical, { bigint: true }));
    if (!identity.isFile()) { throw new Error('File mention must refer to a regular file.'); }
    if (expected && (canonical !== expected.canonicalPath || identity.dev !== expected.dev || identity.ino !== expected.ino)) {
      throw new Error('File mention changed after shorthand resolution. Select the file again.');
    }
    if (identity.size > BigInt(MAX_FILE_MENTION_BYTES)) { throw new WorkspaceFileMentionContentError('too-large'); }

    let handle: FileHandle | undefined;
    let content: string;
    try {
      // Assign before checking cancellation, so a handle acquired during Stop
      // remains owned by finally and is always closed.
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
      handle = await fs.promises.open(canonical, flags);
      check();
      const opened = await checked(handle.stat({ bigint: true }));
      if (!opened.isFile() || !sameIdentity(identity, opened)) { throw new Error('File mention changed while opening.'); }
      if (opened.size > BigInt(MAX_FILE_MENTION_BYTES)) { throw new WorkspaceFileMentionContentError('too-large'); }

      const selectedNow = await checked(fs.promises.realpath(selected));
      const canonicalNow = await checked(fs.promises.realpath(canonical));
      const targetNow = await checked(fs.promises.lstat(canonical, { bigint: true }));
      const rootNow = await checked(fs.promises.realpath(root.declared));
      const canonicalRootNow = await checked(fs.promises.realpath(root.canonical));
      const rootIdentityNow = await checked(fs.promises.lstat(root.canonical, { bigint: true }));
      if (selectedNow !== canonical || canonicalNow !== canonical || !targetNow.isFile()
        || !sameIdentity(opened, targetNow) || rootNow !== root.canonical || canonicalRootNow !== root.canonical
        || !rootIdentityNow.isDirectory() || !sameIdentity(root.identity, rootIdentityNow)) {
        throw new Error('File mention or workspace folder changed before reading.');
      }
      if (targetNow.size > BigInt(MAX_FILE_MENTION_BYTES)) { throw new WorkspaceFileMentionContentError('too-large'); }

      // Metadata alone cannot bound a growing file. Read at most one byte past
      // the limit through this same verified handle, then reject without partial
      // context. Decode once so UTF-8 characters spanning chunks stay intact.
      const chunks: Buffer[] = [];
      let byteLength = 0;
      while (true) {
        check();
        const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_FILE_MENTION_BYTES + 1 - byteLength));
        const { bytesRead } = await checked(handle.read(buffer, 0, buffer.length, null));
        if (bytesRead === 0) { break; }
        byteLength += bytesRead;
        if (byteLength > MAX_FILE_MENTION_BYTES) { throw new WorkspaceFileMentionContentError('too-large'); }
        const chunk = buffer.subarray(0, bytesRead);
        if (chunk.includes(0)) { throw new WorkspaceFileMentionContentError('binary'); }
        chunks.push(chunk);
      }
      content = Buffer.concat(chunks, byteLength).toString('utf-8');
    } finally {
      if (handle) { await handle.close(); }
    }
    check();
    return { path: selected, content };
  } catch (error) {
    if (error === cancelled || isCancelled()) { return undefined; }
    throw error;
  }
}
