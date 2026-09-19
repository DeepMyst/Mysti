/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import fs from 'fs/promises';
import path from 'path';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { pathToFileURL } from 'url';
import type { ToolCall } from '../../../src/types';
import { isRecord } from '../../../src/utils/valueGuards';
import type { NativeApprovalDecision } from '../../../src/providers/base/IProvider';
import type { AcpObject } from '../../../src/providers/base/AcpNativeTypes';

/** Prototype-only port; not exposed by the shipped ACP client. */
export interface OpenCodeGatePrototypeClient {
  sessionId?: string;
  requestHookApproval(sessionId: string, tool: ToolCall, signal: AbortSignal): Promise<NativeApprovalDecision>;
  failOwnedHook(message: string): void;
}

const MAX_BYTES = 128 * 1024;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192;

/** File-only plugin: no imports, package resolution, shell, or fallback decision. */
export function openCodeGatePluginSource(endpoint: string, token: string, cwd: string): string {
  return `export default async function MystiOwnedApproval(input) {
  const endpoint = ${JSON.stringify(endpoint)}, token = ${JSON.stringify(token)}, cwd = ${JSON.stringify(cwd)};
  async function rpc(route, body, timeout) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await fetch(endpoint + route, {method:'POST', redirect:'error', signal:abort.signal,
        headers:{'content-type':'application/json',authorization:'Bearer ' + token}, body:JSON.stringify(body)});
      if (!response.ok) throw new Error('Mysti approval channel refused the request');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  if (input.directory !== cwd) throw new Error('Mysti approval workspace changed');
  return {
    config: async () => {
      const result = await rpc('/ready', {cwd, version:1}, 10000);
      if (result.ready !== true) throw new Error('Mysti approval gate is unavailable');
    },
    'tool.execute.before': async (call, output) => {
      if (call.tool !== 'bash') {
        if (!['read','glob','grep','edit','write','apply_patch','webfetch'].includes(call.tool)) throw new Error('Unsupported Mysti native tool');
        return;
      }
      const args = output.args;
      if (!args || typeof args.command !== 'string') throw new Error('Invalid Mysti shell authority');
      Object.freeze(args);
      const result = await rpc('/approval', {cwd, sessionId:call.sessionID, callId:call.callID, tool:call.tool, args}, 600000);
      if (result.decision !== 'allow' || result.sessionId !== call.sessionID || result.callId !== call.callID || result.command !== args.command)
        throw new Error('Mysti denied or cancelled shell execution');
    }
  };
}
`;
}

/** One authenticated hook server belongs to one native process/session/turn. */
export class OpenCodeExecutionGate {
  private readonly _token = randomBytes(32).toString('hex');
  private readonly _server = createServer((request, response) => { void this._handle(request, response); });
  private readonly _requests = new Set<AbortController>();
  private readonly _seen = new Set<string>();
  private readonly _approved = new Map<string, ToolCall>();
  private readonly _readyListeners = new Set<() => void>();
  private _ready = false;
  private _disposed = false;
  private _client?: OpenCodeGatePrototypeClient;
  private _closed?: Promise<void>;
  private readonly _onAbort = () => { void this.dispose(); };
  readonly pluginPath: string;
  get pluginUrl(): string { return pathToFileURL(this.pluginPath).href; }

  private constructor(directory: string, readonly cwd: string, private readonly _signal: AbortSignal) {
    this.pluginPath = path.join(directory, 'mysti-approval.mjs');
    this._server.requestTimeout = 10000; this._server.headersTimeout = 5000;
    this._server.on('error', () => {
      this._client?.failOwnedHook('The owned native approval channel failed.');
      void this.dispose();
    });
    _signal.addEventListener('abort', this._onAbort, { once: true });
  }

  static async create(directory: string, cwd: string, signal: AbortSignal): Promise<OpenCodeExecutionGate> {
    const gate = new OpenCodeExecutionGate(directory, await fs.realpath(cwd), signal);
    try {
      if (signal.aborted) { throw new Error('OpenCode setup was cancelled.'); }
      await new Promise<void>((resolve, reject) => {
        gate._server.once('error', reject);
        gate._server.listen(0, '127.0.0.1', () => { gate._server.removeListener('error', reject); resolve(); });
      });
      const address = gate._server.address();
      if (!address || typeof address === 'string' || signal.aborted) { throw new Error('OpenCode approval listener is unavailable.'); }
      await fs.writeFile(gate.pluginPath, openCodeGatePluginSource(`http://127.0.0.1:${address.port}`, gate._token, gate.cwd), { mode: 0o400 });
      return gate;
    } catch (error) { await gate.dispose(); throw error; }
  }

  async bind(client: OpenCodeGatePrototypeClient, timeoutMs = 10000): Promise<void> {
    if (this._client || !client.sessionId) { throw new Error('OpenCode hook session ownership is unavailable.'); }
    this._client = client;
    if (this._ready && !this._disposed) { return; }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (!this._ready && !this._disposed) { return; }
        clearTimeout(timer); this._readyListeners.delete(finish);
        if (this._disposed) { reject(new Error('OpenCode approval setup was cancelled.')); } else { resolve(); }
      };
      const timer = setTimeout(() => {
        this._readyListeners.delete(finish);
        reject(new Error('OpenCode did not load the owned approval gate; no prompt was sent.'));
      }, timeoutMs);
      this._readyListeners.add(finish); finish();
    });
  }

  private _authenticated(request: IncomingMessage): boolean {
    const value = request.headers.authorization;
    const expected = Buffer.from(`Bearer ${this._token}`);
    return typeof value === 'string' && Buffer.byteLength(value) === expected.length && timingSafeEqual(Buffer.from(value), expected);
  }

  private async _handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) { controller.abort(); } };
    response.once('close', abort); request.once('aborted', abort);
    this._requests.add(controller);
    const reply = (status: number, body: object) => {
      if (!response.destroyed && !response.writableEnded) { response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)); }
    };
    try {
      if (this._disposed || this._signal.aborted || !this._authenticated(request) || request.method !== 'POST'
        || !['/ready', '/approval'].includes(request.url ?? '') || this._requests.size > 64) { reply(403, { decision: 'deny' }); return; }
      const chunks: Buffer[] = []; let length = 0;
      for await (const part of request) {
        length += part.length;
        if (length > MAX_BYTES) { reply(413, { decision: 'deny' }); return; }
        chunks.push(Buffer.from(part));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!isRecord(body) || body.cwd !== this.cwd || controller.signal.aborted || this._signal.aborted) { reply(403, { decision: 'deny' }); return; }
      if (request.url === '/ready') {
        if (body.version !== 1 || this._ready) { reply(403, { decision: 'deny' }); return; }
        this._ready = true; reply(200, { ready: true });
        for (const listener of this._readyListeners) { listener(); }
        return;
      }
      const args = body.args;
      if (!this._ready || !this._client || body.sessionId !== this._client.sessionId || !validId(body.callId)
        || body.tool !== 'bash' || this._seen.has(body.callId) || this._seen.size >= 4096 || !isRecord(args)
        || typeof args.command !== 'string' || !args.command.trim() || args.command.length > 65536
        || (args.workdir !== undefined && (typeof args.workdir !== 'string' || path.resolve(this.cwd, args.workdir) !== this.cwd))) {
        reply(403, { decision: 'deny' }); return;
      }
      this._seen.add(body.callId);
      const input: Readonly<Record<string, unknown>> = Object.freeze({ ...args, cwd: this.cwd });
      const tool: ToolCall = Object.freeze({ id: body.callId, name: 'Bash', input, kind: 'execute', status: 'running' });
      const decision = await this._client.requestHookApproval(body.sessionId as string, tool, controller.signal);
      const allowed = decision === 'allow' && !controller.signal.aborted && !this._signal.aborted && !this._disposed;
      if (allowed) { this._approved.set(tool.id, tool); }
      reply(200, { decision: allowed ? 'allow' : 'deny', sessionId: body.sessionId, callId: body.callId, command: input.command });
    } catch { reply(403, { decision: 'deny' }); }
    finally {
      controller.abort(); this._requests.delete(controller);
      request.removeListener('aborted', abort); response.removeListener('close', abort);
    }
  }

  /** Scanner permissions cannot introduce new command authority after the hook. */
  decodePermission(params: Readonly<AcpObject>, tracked: Readonly<AcpObject> | undefined): ToolCall | undefined {
    if (this._disposed || this._signal.aborted || params.sessionId !== this._client?.sessionId || !isRecord(params.toolCall)) { return; }
    const call = params.toolCall;
    if (typeof call.toolCallId !== 'string' || call.kind !== 'execute' || !isRecord(call.rawInput)) { return; }
    const approved = this._approved.get(call.toolCallId);
    if (!approved || tracked?.toolCallId !== approved.id || tracked.kind !== 'execute' || !isRecord(tracked.rawInput)
      || tracked.rawInput.command !== approved.input.command || call.rawInput.command !== approved.input.command
      || Object.keys(call.rawInput).some(key => key !== 'command')) { return; }
    return approved;
  }

  consumeApproval(tool: Readonly<ToolCall>): boolean {
    const approved = this._approved.get(tool.id);
    if (!approved || this._disposed || this._signal.aborted || tool.name !== approved.name || JSON.stringify(tool.input) !== JSON.stringify(approved.input)) { return false; }
    this._approved.delete(tool.id); return true;
  }

  invalidateApproval(toolId: string): void { this._approved.delete(toolId); }

  dispose(): Promise<void> {
    if (this._closed) { return this._closed; }
    this._disposed = true; this._signal.removeEventListener('abort', this._onAbort);
    this._approved.clear();
    for (const controller of this._requests) { controller.abort(); }
    for (const listener of this._readyListeners) { listener(); }
    this._closed = new Promise(resolve => {
      this._server.close(() => resolve()); this._server.closeAllConnections();
    });
    return this._closed;
  }
}
