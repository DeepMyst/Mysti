import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

/** All prior clipboard data stays in the Swift process, never in this client. */
export class NativeClipboardGuard {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending?: { requestId: string; resolve(value: any): void; reject(error: Error): void; timeout: NodeJS.Timeout };
  private readonly finished: Promise<number | null>;
  private nextRequestId = 0;
  private terminalError?: Error;
  constructor(script: string) {
    this.child = spawn('swift', [script, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => { /* Never forward incidental platform diagnostics to evidence. */ });
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      let result: any;
      try { result = JSON.parse(line); } catch {
        const pending = this.pending;
        if (pending) { this.pending = undefined; clearTimeout(pending.timeout); pending.reject(new Error('Clipboard guard returned invalid metadata')); }
        return;
      }
      const pending = this.pending;
      // Timed-out replies and unsolicited shutdown metadata cannot resolve a
      // later restore/quit command. Only the matching command owns this reply.
      if (!pending || result.requestId !== pending.requestId) { return; }
      this.pending = undefined; clearTimeout(pending.timeout); pending.resolve(result);
    });
    this.finished = new Promise(resolve => {
      const finish = (code: number | null, error: Error): void => {
        this.terminalError = error;
        if (this.pending) { clearTimeout(this.pending.timeout); this.pending.reject(error); this.pending = undefined; }
        resolve(code);
      };
      this.child.once('exit', code => finish(code, new Error('Clipboard guard exited during a command')));
      this.child.once('error', () => finish(null, new Error('Clipboard guard could not start')));
    });
    this.child.stdin.on('error', () => { /* The matching write callback rejects without exposing platform diagnostics. */ });
  }
  get pid(): number | undefined { return this.child.pid; }
  async request(command: Record<string, unknown>): Promise<any> {
    if (this.pending) { throw new Error('Clipboard guard commands must be sequential'); }
    if (this.terminalError) { throw this.terminalError; }
    if (this.child.exitCode !== null) { throw new Error('Clipboard guard already exited'); }
    const requestId = String(++this.nextRequestId);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { if (this.pending?.requestId === requestId) { this.pending = undefined; } reject(new Error('Clipboard guard metadata deadline expired')); }, 15000);
      this.pending = { requestId, resolve, reject, timeout };
      this.child.stdin.write(JSON.stringify({ ...command, requestId }) + '\n', error => { if (error && this.pending?.requestId === requestId) { clearTimeout(timeout); this.pending = undefined; reject(new Error('Clipboard guard input closed')); } });
    });
  }
  async quit(): Promise<any> {
    const result = await this.request({ action: 'quit' });
    if (!result.ok) { throw new Error('Clipboard restoration failed; helper retains its RAM snapshot'); }
    this.child.stdin.end();
    let timeout: NodeJS.Timeout | undefined;
    let code: number | null;
    try { code = await Promise.race([this.finished, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Clipboard helper did not exit')), 10000); })]); }
    finally { clearTimeout(timeout); }
    if (code !== 0) { throw new Error('Clipboard helper failed during shutdown'); }
    return result;
  }
}
