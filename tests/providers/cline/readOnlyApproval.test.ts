import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import { ClineReadOnlyApproval } from '../../../src/providers/cline/ClineReadOnlyApproval';

// Keep real filesystem I/O, with narrow instrumentation to observe creation and
// deliver cancellation at the synchronous publication boundary.
const io = vi.hoisted(() => ({ created: [] as string[], afterWrite: undefined as ((file: unknown) => void) | undefined }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<any>('fs');
  return {
    ...actual,
    mkdtempSync: (prefix: string, ...options: unknown[]) => {
      const result = actual.mkdtempSync(prefix, ...options);
      if (prefix.includes('mysti-cline-approval-')) io.created.push(result);
      return result;
    },
    writeFileSync: (...args: unknown[]) => {
      const result = actual.writeFileSync(...args);
      io.afterWrite?.(args[0]);
      return result;
    },
  };
});

const settings = { mode: 'quick-plan', accessLevel: 'read-only', model: '', contextMode: 'manual' } as Settings;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) return false; await pause(10); }
  return true;
}
let provider: TestableClineProvider;
let directory: string;
let originalFolders: typeof vscode.workspace.workspaceFolders;
const children: Array<{ process: ChildProcess; closed: boolean }> = [];

beforeEach(() => {
  io.created.length = 0; io.afterWrite = undefined;
  clearMockConfig();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cline-readonly-test-'));
  originalFolders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(directory), name: 'owned read-only fixture', index: 0 }] });
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  provider = new TestableClineProvider();
  (provider as any)._cachedCliVersion = '3.0.61';
});
afterEach(async () => {
  io.afterWrite = undefined;
  provider.dispose();
  const closed = await until(() => children.every(child => child.closed));
  for (const child of children) if (!child.closed) child.process.kill('SIGKILL');
  await until(() => children.every(child => child.closed));
  children.length = 0;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: originalFolders });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); clearConfigurationListeners(); clearMockConfig();
  fs.rmSync(directory, { recursive: true, force: true });
  expect(closed, 'Provider must close its actual owned child').toBe(true);
});

// Only a harmless owned Node fixture can be launched here. Constrained modes
// must reject before prompt construction or process creation; unrestricted and
// legacy controls retain their existing transport selection.
function fixture() {
  const script = path.join(directory, 'fixture.cjs');
  const marker = path.join(directory, 'spawned.json');
  fs.writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),backendMode:process.env.CLINE_SESSION_BACKEND_MODE,approvalMode:process.env.CLINE_TOOL_APPROVAL_MODE}));
process.stdout.write(JSON.stringify({type:'agent_event',event:{type:'content_start',contentType:'text',text:'owned fixture completed'}})+'\\n');
process.stdout.write(JSON.stringify({type:'run_result',finishReason:'completed'})+'\\n');
`);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  const build = provider.buildCliArgs.bind(provider);
  vi.spyOn(provider, 'buildCliArgs').mockImplementation((s, session) => [script, ...build(s, session)]);
  const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: string) => content);
  const cancel = vi.spyOn(provider, 'cancelCurrentRequest');
  const tracker = {
    registerProcess(_panel: string, process: ChildProcess) {
      const row = { process, closed: false }; children.push(row);
      process.once('close', () => { row.closed = true; });
    }, clearProcess() {},
  };
  const send = async (requestSettings = settings) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('private user request', [], requestSettings, null, undefined, 'panel', tracker)) chunks.push(chunk);
    return chunks;
  };
  return { send, marker, prompt, cancel };
}

describe('Cline constrained transport preflight', () => {
  it.each([
    ['3.0.61', 'quick-plan', 'full-access'],
    ['3.0.61', 'detailed-plan', 'full-access'],
    ['3.0.61', 'default', 'read-only'],
    ['2.0.0', 'quick-plan', 'full-access'],
    ['2.0.0', 'detailed-plan', 'full-access'],
    ['2.0.0', 'default', 'read-only'],
    [null, 'quick-plan', 'full-access'],
    [null, 'detailed-plan', 'full-access'],
    [null, 'default', 'read-only'],
  ] as const)('refuses unsupported constrained dispatch before context or spawn (%s, %s, %s)', async (version, mode, accessLevel) => {
    (provider as any)._cachedCliVersion = version;
    const h = fixture();
    vi.stubEnv('CLINE_SESSION_BACKEND_MODE', 'hub');
    vi.stubEnv('CLINE_TOOL_APPROVAL_MODE', 'desktop');
    await expect(h.send({ ...settings, mode, accessLevel })).rejects.toThrow(
      `Cline${version ? ` ${version}` : ''} cannot use Plan or Read Only safely through this CLI connection. Choose another provider for this mode.`,
    );
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
    expect(io.created).toHaveLength(0);
    expect(fs.existsSync(h.marker)).toBe(false);
    expect(process.env.CLINE_SESSION_BACKEND_MODE).toBe('hub');
    expect(process.env.CLINE_TOOL_APPROVAL_MODE).toBe('desktop');
    expect(provider.capabilities.supportsReadOnly).toBe(false);
    expect(provider.capabilities.planMode).toBe('none');
  });

  it.each([
    ['3.0.61', 'default', 'full-access'],
    ['1.0.8', 'quick-plan', 'read-only'],
  ] as const)('preserves explicit unrestricted and legacy transport (%s)', async (version, mode, accessLevel) => {
    (provider as any)._cachedCliVersion = version;
    const h = fixture();
    vi.stubEnv('CLINE_SESSION_BACKEND_MODE', 'remote');
    const chunks = await h.send({ ...settings, mode, accessLevel });
    const launched = JSON.parse(fs.readFileSync(h.marker, 'utf8'));
    expect(launched.backendMode).toBe('remote');
    expect(process.env.CLINE_SESSION_BACKEND_MODE).toBe('remote');
    expect(io.created).toHaveLength(0);
    expect(chunks.some(chunk => chunk.content === 'owned fixture completed')).toBe(true);
    if (version === '1.0.8') {
      expect(launched.args).toEqual(expect.arrayContaining(['--mode', 'plan']));
      expect(provider.capabilities.supportsReadOnly).not.toBe(false);
      expect(provider.capabilities.planMode).toBe('detected');
    } else {
      expect(launched.args.slice(launched.args.indexOf('--auto-approve'), launched.args.indexOf('--auto-approve') + 2)).toEqual(['--auto-approve', 'true']);
    }
  });
});

function requestFiles(approvalDirectory: string, toolCallId: string, toolName: string, sessionId = 'owned-session') {
  const requestId = toolCallId.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return {
    requestPath: path.join(approvalDirectory, `${sessionId}.request.${requestId}.json`),
    decisionPath: path.join(approvalDirectory, `${sessionId}.decision.${requestId}.json`),
    body: { requestId, sessionId, createdAt: new Date().toISOString(), toolCallId, toolName, input: {}, iteration: 1, agentId: 'agent', conversationId: 'conversation' },
  };
}
function bridge() {
  const controller = new AbortController();
  let current = true;
  const scope = new ClineReadOnlyApproval({ signal: controller.signal, isCurrent: () => current });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const row = { process: child, closed: false }; children.push(row);
  child.once('close', () => { row.closed = true; });
  scope.bind(child);
  return {
    scope, controller, revoke: () => { current = false; },
    async close() {
      scope.dispose(); child.kill('SIGTERM');
      expect(await until(() => row.closed && !fs.existsSync(scope.directory))).toBe(true);
    },
  };
}
async function decision(files: ReturnType<typeof requestFiles>) {
  expect(await until(() => fs.existsSync(files.decisionPath))).toBe(true);
  return JSON.parse(fs.readFileSync(files.decisionPath, 'utf8'));
}

// Isolated helper qualification only: this bridge is not an active CLI transport.
describe('Cline isolated desktop approval file protocol', () => {
  it('routes a native tool-call ID containing the request delimiter to its exact decision filename', async () => {
    const h = bridge();
    try {
      const files = requestFiles(h.scope.directory, 'call.request.segment', 'read_files');
      fs.writeFileSync(files.requestPath, JSON.stringify(files.body));
      expect(await decision(files)).toEqual({ requestId: 'call.request.segment', sessionId: 'owned-session', approved: true });
    } finally { await h.close(); }
  });

  it('retries a partial native write and publishes an atomic matching read approval', async () => {
    const h = bridge();
    try {
      const files = requestFiles(h.scope.directory, 'partial:call', 'read_files');
      fs.writeFileSync(files.requestPath, '{"requestId":');
      await pause(80);
      expect(fs.existsSync(files.decisionPath)).toBe(false);
      fs.writeFileSync(files.requestPath, JSON.stringify(files.body));
      expect(await decision(files)).toEqual({ requestId: 'partial_call', sessionId: 'owned-session', approved: true });
      expect(fs.readdirSync(h.scope.directory).some(name => name.endsWith('.tmp'))).toBe(false);
    } finally { await h.close(); }
  });

  it('denies unsafe files and malformed complete requests without following links or hanging', async () => {
    const h = bridge();
    try {
      const outside = path.join(directory, 'outside-request');
      const valid = requestFiles(h.scope.directory, 'link', 'read_files');
      const untouched = JSON.stringify(valid.body);
      fs.writeFileSync(outside, untouched);
      fs.symlinkSync(outside, valid.requestPath);
      const oversized = requestFiles(h.scope.directory, 'large', 'read_files');
      fs.writeFileSync(oversized.requestPath, 'x'.repeat(256 * 1024 + 1));
      const nonregular = requestFiles(h.scope.directory, 'directory', 'read_files');
      fs.mkdirSync(nonregular.requestPath);
      const malformed = requestFiles(h.scope.directory, 'malformed', 'read_files');
      fs.writeFileSync(malformed.requestPath, '{');
      for (const files of [valid, oversized, nonregular, malformed]) expect(await decision(files)).toMatchObject({ approved: false });
      expect(fs.readFileSync(outside, 'utf8')).toBe(untouched);
    } finally { await h.close(); }
  });

  it('denies mismatched routing, sanitized-ID reuse, foreign sessions and read-like unknown tool names', async () => {
    const h = bridge();
    try {
      const first = requestFiles(h.scope.directory, 'collision:1', 'read_files');
      fs.writeFileSync(first.requestPath, JSON.stringify(first.body));
      expect((await decision(first)).approved).toBe(true);
      fs.unlinkSync(first.requestPath); fs.unlinkSync(first.decisionPath);
      const collided = requestFiles(h.scope.directory, 'collision/1', 'read_files');
      fs.writeFileSync(collided.requestPath, JSON.stringify(collided.body));
      expect((await decision(collided)).approved).toBe(false);
      const wrongSession = requestFiles(h.scope.directory, 'wrong-session', 'read_files');
      wrongSession.body.sessionId = 'not-the-filename';
      const wrongId = requestFiles(h.scope.directory, 'wrong-id', 'read_files');
      wrongId.body.requestId = 'not-the-filename';
      const wrongCall = requestFiles(h.scope.directory, 'wrong-call', 'read_files');
      wrongCall.body.toolCallId = 'different-call';
      const foreign = requestFiles(h.scope.directory, 'foreign-call', 'read_files', 'foreign-session');
      const unknown = requestFiles(h.scope.directory, 'unknown', 'plugin:read_files');
      for (const files of [wrongSession, wrongId, wrongCall, foreign, unknown]) {
        fs.writeFileSync(files.requestPath, JSON.stringify(files.body));
        expect((await decision(files)).approved).toBe(false);
      }
    } finally { await h.close(); }
  });

  it('revokes approval between decision staging and publication, retaining files until child close', async () => {
    const h = bridge();
    try {
      const files = requestFiles(h.scope.directory, 'cancel-at-publication', 'read_files');
      fs.writeFileSync(files.requestPath, JSON.stringify(files.body));
      io.afterWrite = file => {
        if (typeof file === 'string' && file.startsWith(h.scope.directory) && file.endsWith('.tmp')) h.controller.abort();
      };
      await pause(80);
      expect(h.controller.signal.aborted).toBe(true);
      expect(fs.existsSync(files.decisionPath)).toBe(false);
      expect(fs.existsSync(h.scope.directory)).toBe(true);
      expect(fs.readdirSync(h.scope.directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally { await h.close(); }
  });

  it('cleans before spawn when cancelled and never recreates a revoked request directory', () => {
    const controller = new AbortController();
    controller.abort();
    const scope = new ClineReadOnlyApproval({ signal: controller.signal, isCurrent: () => false });
    expect(fs.existsSync(scope.directory)).toBe(false);
    scope.dispose();
    expect(fs.existsSync(scope.directory)).toBe(false);
  });

  it('does not remove or traverse a directory that replaced its owned temporary directory', () => {
    const controller = new AbortController();
    const scope = new ClineReadOnlyApproval({ signal: controller.signal, isCurrent: () => true });
    const displaced = path.join(directory, 'original-approval-directory');
    fs.renameSync(scope.directory, displaced);
    fs.mkdirSync(scope.directory);
    const unrelated = path.join(scope.directory, 'must-remain');
    fs.writeFileSync(unrelated, 'unrelated directory contents');
    try {
      scope.dispose();
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated directory contents');
    } finally { fs.rmSync(scope.directory, { recursive: true, force: true }); }
  });
});
