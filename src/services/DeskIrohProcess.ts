import { fork } from 'child_process';
import * as path from 'path';
import { existsSync } from 'fs';
import { supportsDeskIroh } from './DeskIrohNative';
import { validDeskRelay } from './desk/DeskIrohLink';
import type { DeskTransport } from './DeskClient';

export interface DeskNativeServer { endpointId: string; close(): void }
export interface DeskNativeCarrier {
  available(): boolean;
  serve(relayUrl: string, bearer: string, handle: (body: unknown) => Promise<unknown>, signal: AbortSignal): Promise<DeskNativeServer>;
  post(relayUrl: string, endpointId: string, body: unknown, opts: Parameters<DeskTransport['post']>[2]): ReturnType<DeskTransport['post']>;
}

/** The native runtime owns no device key, vault, workspace, or provider handle. */
export class DeskIrohProcess implements DeskNativeCarrier {
  constructor(private readonly _root: string) {}

  available(): boolean {
    return supportsDeskIroh(process.versions.node, process.platform, process.arch)
      && existsSync(path.join(this._root, 'resources/desk-native/manifest.json'))
      && existsSync(path.join(this._root, 'dist/deskIrohWorker.js'));
  }

  private _run(message: Record<string, unknown>, signal: AbortSignal,
    handle?: (body: unknown) => Promise<unknown>): Promise<DeskNativeServer | Awaited<ReturnType<DeskTransport['post']>>> {
    if (!this.available() || !validDeskRelay(message.relayUrl) || signal.aborted) {
      return Promise.reject(new Error('Desk native transport unavailable'));
    }
    return new Promise((resolve, reject) => {
      // Do not inherit provider credentials, native-loader overrides, inspector
      // flags, or a user Node startup script. HOME/CODEX_HOME are not assigned.
      const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
      for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
        if (process.env[key]) { env[key] = process.env[key]; }
      }
      const child = fork(path.join(this._root, 'dist/deskIrohWorker.js'), [], {
        cwd: this._root, env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let stopped = false, ready = false, pending = 0;
      const stop = () => {
        if (stopped) { return; }
        stopped = true; clearTimeout(timer); signal.removeEventListener('abort', stop);
        // A process boundary bounds even a native bind/close that never returns.
        child.kill('SIGKILL');
        reject(new Error('Desk native transport stopped'));
      };
      const timer = setTimeout(stop, message.mode === 'call' ? Number(message.timeoutMs) : 5000);
      signal.addEventListener('abort', stop, { once: true });
      child.once('error', stop); child.once('exit', stop);
      child.on('message', async (raw: unknown) => {
        if (stopped || !raw || typeof raw !== 'object') { return; }
        const value = raw as { kind?: string; endpointId?: string; id?: number; body?: unknown; result?: unknown };
        if (value.kind === 'ready' && handle && !ready && /^[a-f0-9]{64}$/.test(value.endpointId ?? '')) {
          ready = true; clearTimeout(timer);
          resolve({ endpointId: value.endpointId!, close: stop });
        } else if (value.kind === 'request' && ready && handle && Number.isSafeInteger(value.id) && pending < 4) {
          ++pending;
          try {
            const body = await handle(value.body);
            if (!stopped) { child.send({ kind: 'response', id: value.id, body }, error => { if (error) { stop(); } }); }
          } catch { stop(); }
          finally { --pending; }
        } else if (value.kind === 'result' && !handle) {
          resolve(value.result as Awaited<ReturnType<DeskTransport['post']>>); stop();
        } else { stop(); }
      });
      if (signal.aborted) { stop(); }
      if (!stopped) { child.send(message, error => { if (error) { stop(); } }); }
    });
  }

  serve(relayUrl: string, bearer: string, handle: (body: unknown) => Promise<unknown>, signal: AbortSignal): Promise<DeskNativeServer> {
    return this._run({ mode: 'serve', relayUrl, bearer }, signal, handle) as Promise<DeskNativeServer>;
  }

  post(relayUrl: string, endpointId: string, body: unknown, opts: Parameters<DeskTransport['post']>[2]): ReturnType<DeskTransport['post']> {
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > 10_000) {
      return Promise.reject(new Error('Desk native deadline invalid'));
    }
    return this._run({ mode: 'call', relayUrl, endpointId, body,
      bearer: opts.bearer, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes }, opts.signal) as ReturnType<DeskTransport['post']>;
  }
}
