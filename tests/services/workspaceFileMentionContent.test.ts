import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceFileMention } from '../../src/services/WorkspaceFileMention';

const LIMIT = 5_000_000;
const CHUNK = 64 * 1024;
const realOpen = fs.promises.open.bind(fs.promises);
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
interface Operation { kind: 'readFile' | 'read'; requestedBytes: number | null; bytesRead: number; settled: boolean }
interface HandleReceipt { path: string; operations: Operation[]; closes: number; closed: boolean }
let root: string;
let handles: Array<{ handle: FileHandle; receipt: HandleReceipt; rawStat: () => Promise<unknown> }>;
let inputs: Array<{ path: string; bytes: number; sha256: string }>;
let outcomes: unknown[];
let beforeRead: (kind: Operation['kind'], ordinal: number) => Promise<void>;
let shortReadLimit: number | undefined;
let events: unknown[];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
function operations() { return handles.flatMap(item => item.receipt.operations); }
function assertBounded() {
  expect(operations().every(operation => operation.kind === 'read'), 'bounded content reads use the owned handle').toBe(true);
  expect(operations().every(operation => operation.requestedBytes !== null && operation.requestedBytes > 0 && operation.requestedBytes <= CHUNK)).toBe(true);
  expect(operations().reduce((sum, operation) => sum + operation.bytesRead, 0)).toBeLessThanOrEqual(LIMIT + 1);
}

function file(name: string, bytes: string | Buffer) {
  const target = path.join(root, name), buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  fs.writeFileSync(target, buffer); inputs.push({ path: target, bytes: buffer.length, sha256: hash(buffer) }); return target;
}
async function read(target: string, cancelled = () => false) {
  try {
    const value = await readWorkspaceFileMention(target, [root], cancelled);
    const outcome = value === undefined ? { kind: 'cancelled' as const } : {
      kind: 'returned' as const, path: value.path, characters: value.content.length,
      utf8Bytes: Buffer.byteLength(value.content), sha256: hash(value.content), containsNul: value.content.includes('\0'),
    };
    outcomes.push(outcome); return { outcome, value };
  } catch (error) {
    const outcome = { kind: 'rejected' as const, message: error instanceof Error ? error.message : String(error) };
    outcomes.push(outcome); return { outcome, value: undefined };
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-mention-content-')));
  handles = []; inputs = []; outcomes = []; beforeRead = async () => undefined; shortReadLimit = undefined; events = [];
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const receipt: HandleReceipt = { path: String(args[0]), operations: [], closes: 0, closed: false };
    const rawStat = handle.stat.bind(handle), readFile = handle.readFile.bind(handle), readChunk = handle.read.bind(handle), close = handle.close.bind(handle);
    handles.push({ handle, receipt, rawStat });
    vi.spyOn(handle, 'readFile').mockImplementation((async (...options: any[]) => {
      const operation: Operation = { kind: 'readFile', requestedBytes: null, bytesRead: 0, settled: false };
      receipt.operations.push(operation); await beforeRead('readFile', receipt.operations.length);
      const value = await (readFile as any)(...options);
      operation.bytesRead = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value); operation.settled = true;
      return value;
    }) as any);
    vi.spyOn(handle, 'read').mockImplementation((async (...options: any[]) => {
      const requestedBytes = typeof options[2] === 'number' ? options[2]
        : options[0]?.length ?? options[0]?.buffer?.byteLength ?? null;
      const operation: Operation = { kind: 'read', requestedBytes, bytesRead: 0, settled: false };
      receipt.operations.push(operation); await beforeRead('read', receipt.operations.length);
      if (shortReadLimit !== undefined) {
        expect(typeof options[2], 'short-read control delegates the positional read overload').toBe('number');
        options[2] = Math.min(options[2], shortReadLimit);
      }
      const value = await (readChunk as any)(...options);
      operation.bytesRead = value.bytesRead; operation.settled = true; return value;
    }) as any);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      receipt.closes++; await close(); receipt.closed = true;
    });
    return handle;
  });
});

afterEach(async () => {
  try {
    for (const { receipt, rawStat } of handles) {
      expect(receipt.closes, 'every acquired real handle closes exactly once').toBe(1);
      expect(receipt.closed).toBe(true);
      await expect(rawStat()).rejects.toMatchObject({ code: 'EBADF' });
    }
  } finally {
    if (process.env.MYSTI_FILE_MENTION_CONTENT_RECEIPTS) fs.appendFileSync(process.env.MYSTI_FILE_MENTION_CONTENT_RECEIPTS,
      JSON.stringify({ test: expect.getState().currentTestName, inputs, outcomes, events, handles: handles.map(item => item.receipt) }) + '\n');
    vi.restoreAllMocks();
    for (const { handle, receipt } of handles) if (!receipt.closed) await handle.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('workspace file mention content boundaries', () => {
  it('preserves ordinary Unicode text independently of file extension', async () => {
    const content = 'Text 雪 مرحبا 🙂\r\n';
    const target = file('ordinary.bin', content), result = await read(target);
    expect(result.outcome.kind).toBe('returned');
    expect(result.value).toEqual({ path: target, content });
  });
  it('rejects an actual NUL byte rather than returning binary content', async () => {
    const target = file('nul.txt', Buffer.from([0x41, 0, 0x42]));
    const result = await read(target);
    expect(result.outcome.kind, 'a NUL-containing real file must be rejected').toBe('rejected');
    expect(result.outcome).toMatchObject({ message: expect.stringContaining('NUL') });
  });
  it('rejects a real file exceeding the raw byte limit by one', async () => {
    const target = file('too-large.txt', Buffer.alloc(LIMIT + 1, 0x61));
    const result = await read(target);
    expect(result.outcome.kind, 'a 5,000,001-byte real file must be rejected').toBe('rejected');
    expect(result.outcome).toMatchObject({ message: expect.stringContaining('5,000,000') });
  });
  it('accepts an empty file and reaches EOF without inventing text', async () => {
    const target = file('empty', ''), result = await read(target);
    expect(result.value).toEqual({ path: target, content: '' });
    assertBounded(); expect(operations().map(operation => operation.bytesRead)).toEqual([0]);
  });
  for (const size of [LIMIT - 1, LIMIT]) {
    it(`preserves exactly ${size} raw bytes and performs a bounded EOF check`, async () => {
      const bytes = Buffer.alloc(size, 0x61), target = file('allowed.txt', bytes), result = await read(target);
      expect(result.outcome).toMatchObject({ kind: 'returned', utf8Bytes: size, sha256: hash(bytes), containsNul: false });
      assertBounded(); expect(operations().at(-1)?.bytesRead).toBe(0);
      expect(operations().reduce((sum, operation) => sum + operation.bytesRead, 0)).toBe(size);
      if (size === LIMIT) expect(operations().at(-1)?.requestedBytes).toBe(1);
    });
  }
  it('accepts the exact raw-byte limit with multibyte text', async () => {
    const bytes = Buffer.from('🙂'.repeat(LIMIT / 4));
    const result = await read(file('unicode-limit.dat', bytes));
    expect(result.outcome).toMatchObject({ kind: 'returned', utf8Bytes: LIMIT, characters: LIMIT / 2, sha256: hash(bytes) });
    assertBounded(); expect(operations().at(-1)?.bytesRead).toBe(0);
  });
  it('rejects excess raw UTF-8 bytes even when character count is below the limit', async () => {
    const bytes = Buffer.from('🙂'.repeat(LIMIT / 4) + 'a');
    expect(bytes.length).toBe(LIMIT + 1);
    const result = await read(file('unicode-too-large.txt', bytes));
    expect(result.outcome.kind).toBe('rejected');
    expect(result.outcome).toMatchObject({ message: expect.stringContaining('5,000,000') });
  });
  it('preserves multibyte characters split across the 64 KiB boundary', async () => {
    const bytes = Buffer.concat([Buffer.alloc(CHUNK - 1, 0x78), Buffer.from('🙂雪 مرحبا\n')]);
    const result = await read(file('split-utf8.txt', bytes));
    expect(result.outcome).toMatchObject({ kind: 'returned', sha256: hash(bytes), utf8Bytes: bytes.length });
    expect(result.value?.content.endsWith('🙂雪 مرحبا\n')).toBe(true);
    assertBounded(); expect(operations().filter(operation => operation.bytesRead > 0)).toHaveLength(2);
  });
  it('retains UTF-8 replacement decoding for malformed non-NUL bytes', async () => {
    const bytes = Buffer.from([0x61, 0xc3, 0x28, 0xff, 0x62]);
    const result = await read(file('malformed.data', bytes));
    expect(result.value?.content).toBe(bytes.toString('utf8'));
    expect(result.outcome.kind).toBe('returned'); assertBounded();
  });
  it('detects NUL beyond the first chunk without reading later content', async () => {
    const bytes = Buffer.alloc(CHUNK * 3, 0x61); bytes[CHUNK + 5] = 0;
    const result = await read(file('late-nul.txt', bytes));
    expect(result.outcome.kind).toBe('rejected'); assertBounded();
    expect(result.outcome).toMatchObject({ message: expect.stringContaining('NUL') });
    expect(operations().map(operation => operation.bytesRead)).toEqual([CHUNK, CHUNK]);
  });
  it('bounds growth after metadata validation to the limit plus one actual bytes', async () => {
    const target = file('growing.txt', Buffer.alloc(16, 0x61));
    beforeRead = async (kind, ordinal) => {
      if (ordinal !== 1) return;
      expect(kind).toBe('read');
      fs.appendFileSync(target, Buffer.alloc(LIMIT + CHUNK - 16, 0x62));
      events.push({ phase: 'grew-after-stat-before-first-read', bytes: fs.statSync(target).size });
    };
    const result = await read(target);
    expect(result.outcome.kind).toBe('rejected'); assertBounded();
    expect(result.outcome).toMatchObject({ message: expect.stringContaining('5,000,000') });
    expect(operations().reduce((sum, operation) => sum + operation.bytesRead, 0)).toBe(LIMIT + 1);
  });
  it('continues after short real reads and decodes their combined UTF-8 bytes', async () => {
    const bytes = Buffer.from('Short reads: 🙂 雪 مرحبا\n'.repeat(7));
    shortReadLimit = 7;
    const result = await read(file('short.txt', bytes));
    expect(result.outcome).toMatchObject({ kind: 'returned', sha256: hash(bytes), utf8Bytes: bytes.length });
    assertBounded(); expect(operations().filter(operation => operation.bytesRead > 0).length).toBeGreaterThan(2);
    expect(operations().every(operation => operation.bytesRead <= 7)).toBe(true);
    expect(operations().at(-1)?.bytesRead).toBe(0);
  });
  it('discards partial content when Stop arrives during the held second read', async () => {
    const target = file('cancel.txt', Buffer.alloc(CHUNK * 3, 0x61));
    const entered = deferred(), release = deferred(); let cancelled = false;
    beforeRead = async (_kind, ordinal) => { if (ordinal === 2) { entered.resolve(); await release.promise; } };
    const pending = read(target, () => cancelled);
    try {
      expect(await Promise.race([entered.promise.then(() => 'second read'), pending.then(() => 'finished')])).toBe('second read');
      expect(operations()[0].bytesRead).toBe(CHUNK);
      cancelled = true; release.resolve();
      expect((await pending).outcome.kind).toBe('cancelled');
      assertBounded(); expect(operations()).toHaveLength(2);
    } finally { release.resolve(); await pending; }
  });
  it('closes the owned handle when a later chunk read rejects', async () => {
    const target = file('read-error.txt', Buffer.alloc(CHUNK * 3, 0x61));
    beforeRead = async (_kind, ordinal) => { if (ordinal === 2) throw new Error('owned later chunk failure'); };
    const result = await read(target);
    expect(result.outcome).toEqual({ kind: 'rejected', message: 'owned later chunk failure' });
    assertBounded(); expect(operations()).toHaveLength(2); expect(operations()[0].bytesRead).toBe(CHUNK);
  });
});
