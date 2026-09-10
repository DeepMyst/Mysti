import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { Settings, StreamChunk } from '../../../src/types';

const fixture = path.resolve(__dirname, '../../fixtures/claudeNativeAgent.mjs');
const settings: Settings = { provider: 'claude-code', mode: 'default', accessLevel: 'ask-permission', model: '', thinkingLevel: 'none', contextMode: 'auto' };
const roots: string[] = [];
const providers: FixtureClaude[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}

class FixtureClaude extends TestableClaudeProvider {
  readonly children: ChildProcess[] = [];
  promptBarrier: Promise<void> | undefined;
  constructor(readonly root: string, readonly persistent: boolean) { super(); providers.push(this); }
  protected override async _validateNativeApprovalCli(): Promise<void> { /* Native installed proof is separate; this process is an inert protocol fixture. */ }
  protected override buildPersistentCliArgs(value: Settings, session: PanelSessionState): string[] | null {
    return this.persistent ? super.buildPersistentCliArgs(value, session) : null;
  }
  protected override _spawnCliProcess(args: string[]): ChildProcess {
    const proc = spawn(process.execPath, [fixture, ...args], { cwd: this.root,
      env: { PATH: process.env.PATH, MYSTI_CLAUDE_FIXTURE_ROOT: this.root }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.push(proc);
    return proc;
  }
  protected override async buildPromptAsync(content: string): Promise<string> {
    await this.promptBarrier;
    return content;
  }
}

async function harness(persistent: boolean, handler?: NativeApprovalHandler) {
  clearMockConfig();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-claude-provider-'));
  roots.push(root);
  const provider = new FixtureClaude(root, persistent);
  provider.setNativeApprovalHost({ handlerForPanel: () => handler });
  const marker = path.join(root, 'marker.txt');
  const collect = async (name = marker, authority = settings): Promise<StreamChunk[]> => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage(JSON.stringify({ marker: name }), [], authority, null, undefined, 'panel')) { chunks.push(chunk); }
    return chunks;
  };
  return { root, provider, marker, collect };
}

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    provider.cancelCurrentRequest('panel'); provider.disposePersistentProcess('panel');
    for (const proc of provider.children) {
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>(resolve => proc.once('close', () => resolve()));
        proc.kill('SIGKILL'); await exited;
      }
    }
  }
  for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); }
});

describe('Claude public sendMessage native permission lifecycle', () => {
  it.each([false, true])('keeps the native pipe open and approves exact final inputs once (persistent=%s)', async persistent => {
    const decision = deferred<boolean>();
    const cards: NativeApprovalRequest[] = [];
    const h = await harness(persistent, request => { cards.push(request); return decision.promise; });
    const done = h.collect();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(existsSync(h.marker)).toBe(false);
    expect(h.provider.children[0].stdin?.writable).toBe(true);
    expect(cards[0].toolCall.input.new_string).toBe('approved\n');
    decision.resolve(true);
    const chunks = await done;
    expect(await fs.readFile(h.marker, 'utf8')).toBe('approved\n');
    expect(new Set(chunks.filter(chunk => chunk.type === 'tool_use').map(chunk => chunk.toolCall?.id)).size).toBe(1);
    expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    expect(chunks.filter(chunk => chunk.type === 'error')).toHaveLength(0);
    expect(cards[0].signal.aborted).toBe(true);
  });

  it.each([false, true])('Stop retires the card and late allow cannot create its marker (persistent=%s)', async persistent => {
    const decision = deferred<boolean>();
    const cards: NativeApprovalRequest[] = [];
    const h = await harness(persistent, request => { cards.push(request); return decision.promise; });
    const done = h.collect();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    h.provider.cancelCurrentRequest('panel');
    decision.resolve(true);
    await done;
    expect(cards[0].signal.aborted).toBe(true);
    expect(existsSync(h.marker)).toBe(false);
  });

  it('captures the handler and settings before preparation, then captures a new scope on the same persistent process', async () => {
    const ready = deferred<void>();
    const barrier = deferred<void>();
    const firstDecision = deferred<boolean>();
    const firstCards: NativeApprovalRequest[] = [];
    const secondCards: NativeApprovalRequest[] = [];
    const h = await harness(true);
    let active: NativeApprovalHandler = request => { firstCards.push(request); return firstDecision.promise; };
    h.provider.setNativeApprovalHost({ handlerForPanel: () => { ready.resolve(); return active; } });
    h.provider.promptBarrier = barrier.promise;
    const mutable = { ...settings };
    const first = h.collect(h.marker, mutable);
    await ready.promise;
    mutable.accessLevel = 'full-access';
    active = request => { secondCards.push(request); return Promise.resolve(true); };
    barrier.resolve();
    await vi.waitFor(() => expect(firstCards).toHaveLength(1));
    expect(firstCards[0].defaultDecision).toBe('ask');
    expect(secondCards).toHaveLength(0);
    firstDecision.resolve(false);
    await first;
    expect(existsSync(h.marker)).toBe(false);
    const secondMarker = path.join(h.root, 'second.txt');
    await h.collect(secondMarker);
    expect(secondCards).toHaveLength(1);
    expect(secondCards[0].id).not.toBe(firstCards[0].id);
    expect(await fs.readFile(secondMarker, 'utf8')).toBe('approved\n');
    expect(h.provider.children).toHaveLength(1);
  });

  it.each([false, true])('hard-denies read-only mutation in the public provider even with a permissive host (persistent=%s)', async persistent => {
    const handler = vi.fn(() => Promise.resolve(true));
    const h = await harness(persistent, handler);
    await h.collect(h.marker, { ...settings, accessLevel: 'read-only' });
    expect(handler).not.toHaveBeenCalled();
    expect(existsSync(h.marker)).toBe(false);
  });
});
