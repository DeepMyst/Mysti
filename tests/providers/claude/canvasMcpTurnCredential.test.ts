/**
 * Per-turn Canvas MCP credential through the real Claude provider spawn path.
 *
 * The inert fixture behaves like the native CLI: it reads `--mcp-config` once
 * at spawn and keeps that HTTP session. A successor turn revokes the old
 * credential and mints a new one; the warm persistent process must not keep
 * serving the successor with a dead (or, worse, a still-valid old) credential.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';
import type { Settings, StreamChunk } from '../../../src/types';
import { CanvasMcpSession } from '../../../src/canvas/CanvasMcpSession';
import { CanvasMcpHttpServer } from '../../../src/services/CanvasMcpHttpServer';
import { CanvasToolServer } from '../../../src/services/CanvasToolServer';
import { CanvasSessionLinker } from '../../../src/managers/CanvasSessionLinker';
import { BrainstormManager } from '../../../src/managers/BrainstormManager';
import { CollaboratorPool } from '../../../src/services/CollaboratorPool';

const fixture = path.resolve(__dirname, '../../fixtures/claudeCanvasMcpAgent.mjs');
const settings: Settings = { provider: 'claude-code', mode: 'default', accessLevel: 'full-access', model: '', thinkingLevel: 'none', contextMode: 'auto' };
const cleanups: Array<() => Promise<void> | void> = [];

class FixtureClaude extends TestableClaudeProvider {
  readonly children = new Map<string, ChildProcess[]>();
  constructor(readonly root: string) { super(); }
  protected override async _validateNativeApprovalCli(): Promise<void> { /* inert protocol fixture */ }
  protected override buildPersistentCliArgs(value: Settings, session: PanelSessionState): string[] | null {
    const args = super.buildPersistentCliArgs(value, session);
    this._spawnPanel = session.panelId;
    return args;
  }
  private _spawnPanel = '';
  protected override _spawnCliProcess(args: string[]): ChildProcess {
    const proc = spawn(process.execPath, [fixture, ...args], { cwd: this.root,
      env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    const list = this.children.get(this._spawnPanel) ?? [];
    list.push(proc);
    this.children.set(this._spawnPanel, list);
    return proc;
  }
  protected override async buildPromptAsync(content: string): Promise<string> { return content; }
}

interface Report { pid: number; resume: string | null; token: string | null; ok: boolean; error: string | null; tools: number }

async function harness() {
  clearMockConfig();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-canvas-mcp-turn-'));
  const provider = new FixtureClaude(root);
  provider.setNativeApprovalHost({ handlerForPanel: () => undefined });
  const linker = new CanvasSessionLinker({ tmpDir: root });
  const toolServer = new CanvasToolServer({ resolveContext: () => null });
  const endpoints: Array<{ url: string; token: string }> = [];
  const mcp = new CanvasMcpSession({
    artifactId: () => 'design-A',
    originPanel: () => 'panel',
    createServer: artifactId => {
      const server = new CanvasMcpHttpServer(toolServer, { artifactId, currentArtifactId: () => 'design-A' });
      return { start: async () => { const h = await server.start(); endpoints.push(h); return h; }, stop: () => server.stop() };
    },
    link: (panelId, endpoint) => provider.setCanvasMcpConfig(panelId, linker.link(panelId, endpoint)),
    unlink: panelId => { linker.unlink(panelId); provider.setCanvasMcpConfig(panelId, null); },
    onError: error => { throw error; },
  });
  cleanups.push(async () => {
    for (const panel of new Set(['panel', 'other', ...provider.children.keys()])) { provider.cancelCurrentRequest(panel); provider.disposePersistentProcess(panel); }
    for (const proc of [...provider.children.values()].flat()) {
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>(resolve => proc.once('close', () => resolve()));
        proc.kill('SIGKILL'); await exited;
      }
    }
    await mcp.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  /** What the host does per ordinary turn: revoke at admission, mint before send. */
  const admitTurn = async (owner?: object) => { void mcp.close(); await mcp.relink('design-A', 'claude-code', owner); };
  const turn = async (panel = 'panel', content = 'go', value: Settings = settings): Promise<{ chunks: StreamChunk[]; report: Report | null }> => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage(content, [], value, null, undefined, panel)) { chunks.push(chunk); }
    const text = chunks.filter(c => c.type === 'text').map(c => c.content).join('');
    return { chunks, report: text ? JSON.parse(text) as Report : null };
  };
  return { provider, mcp, endpoints, admitTurn, turn };
}

function rawStatus(url: string, token: string): Promise<number | 'refused'> {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
    res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', () => resolve('refused'));
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  });
}

afterEach(async () => { for (const cleanup of cleanups.splice(0)) { await cleanup(); } });

describe('Claude Canvas MCP per-turn credential', { timeout: 30_000 }, () => {
  it('a successor turn works on a warm persistent process after its credential rotates', async () => {
    const h = await harness();
    await h.admitTurn();
    const first = await h.turn();
    expect(first.report).toMatchObject({ ok: true, token: `Bearer ${h.endpoints[0].token}` });
    expect(first.report!.tools).toBeGreaterThan(0);

    await h.admitTurn();
    const second = await h.turn();
    // The native client captured its credential at spawn, so the successor
    // needs an owned restart that resumes the same CLI session.
    expect(second.report).toMatchObject({ ok: true, token: `Bearer ${h.endpoints[1].token}`, resume: 'fixture-session' });
    expect(second.report!.pid).not.toBe(first.report!.pid);
    expect(h.provider.children.get('panel')).toHaveLength(2);
    expect(second.chunks.filter(c => c.type === 'error')).toHaveLength(0);
  });

  it('refuses the previous turn credential once a successor is admitted', async () => {
    const h = await harness();
    await h.admitTurn();
    await h.turn();
    const old = h.endpoints[0];
    expect(await rawStatus(old.url, old.token)).not.toBe(401);

    await h.admitTurn();
    const next = h.endpoints[1];
    expect(next.token).not.toBe(old.token);
    expect(['refused', 410]).toContain(await rawStatus(old.url, old.token));
    expect(await rawStatus(next.url, old.token)).toBe(401);
    expect((await h.turn()).report).toMatchObject({ ok: true });
  });

  it('refuses the old credential between admission and the successor mint', async () => {
    const h = await harness();
    await h.admitTurn();
    await h.turn();
    const old = h.endpoints[0];
    void h.mcp.close(); // admission revokes synchronously, before any await
    expect(['refused', 410]).toContain(await rawStatus(old.url, old.token));
  });

  it('leaves a sibling panel warm process and its session untouched', async () => {
    const h = await harness();
    const siblingFirst = await h.turn('other');
    expect(siblingFirst.report).toMatchObject({ ok: false, error: 'no canvas mcp config' });
    await h.admitTurn();
    await h.turn();
    await h.admitTurn();
    await h.turn();
    const siblingSecond = await h.turn('other');
    expect(siblingSecond.report!.pid).toBe(siblingFirst.report!.pid);
    expect(h.provider.children.get('other')).toHaveLength(1);
  });

  it('clearing a config that was never set neither creates a session nor forces a respawn', async () => {
    const h = await harness();
    const sessions = (h.provider as unknown as { _panelSessions: Map<string, PanelSessionState> })._panelSessions;
    h.provider.setCanvasMcpConfig('ghost', null);
    expect(sessions.has('ghost')).toBe(false);
    const first = await h.turn('other');
    h.provider.setCanvasMcpConfig('other', null);
    expect(sessions.get('other')!.canvasMcpRevision).toBeUndefined();
    expect((await h.turn('other')).report!.pid).toBe(first.report!.pid);
  });

  it('a settings-change restart records the new settings, so later turns reuse that process', async () => {
    const h = await harness();
    const thinking: Settings = { ...settings, thinkingLevel: 'high' };
    const first = await h.turn();
    const changed = await h.turn('panel', 'go', thinking);
    expect(changed.report!.pid).not.toBe(first.report!.pid);
    // The respawned process was built from `thinking`; nothing changed since.
    const again = await h.turn('panel', 'go', thinking);
    const third = await h.turn('panel', 'go', thinking);
    expect(again.report!.pid).toBe(changed.report!.pid);
    expect(third.report!.pid).toBe(changed.report!.pid);
    expect(h.provider.children.get('panel')).toHaveLength(2);

    // A credential rotation still forces its own owned restart on top of that.
    await h.admitTurn();
    const rotated = await h.turn('panel', 'go', thinking);
    expect(rotated.report).toMatchObject({ ok: true, token: `Bearer ${h.endpoints[0].token}` });
    expect(rotated.report!.pid).not.toBe(changed.report!.pid);
    expect((await h.turn('panel', 'go', thinking)).report!.pid).toBe(rotated.report!.pid);
    expect(h.provider.children.get('panel')).toHaveLength(3);
  });

  it('Stop still ends a held turn, and the next admitted turn works', async () => {
    const h = await harness();
    await h.admitTurn();
    const held = h.turn('panel', 'hold');
    await vi.waitFor(() => expect(h.provider.children.get('panel')).toHaveLength(1));
    h.provider.cancelCurrentRequest('panel');
    void h.mcp.close(); // host Stop retires the turn's credential too
    const stopped = await held;
    expect(stopped.chunks.at(-1)?.type).toBe('done');
    expect(stopped.report).toBeNull();

    await h.admitTurn();
    const next = await h.turn();
    expect(next.report).toMatchObject({ ok: true, token: `Bearer ${h.endpoints[1].token}` });
  });
});

describe('Claude Canvas MCP credential across lanes and turn completion', { timeout: 30_000 }, () => {
  it('child lanes of the linked panel spawn without the credential and leave the parent warm', async () => {
    const h = await harness();
    await h.admitTurn();
    const parent = await h.turn();
    expect(parent.report).toMatchObject({ ok: true });
    // The derived panel ids the real lane code dispatches under.
    const brainstorm = (BrainstormManager.prototype as unknown as { _childPanelId(s: string, a: string): string })
      ._childPanelId.call(null, 'panel', 'claude-code');
    const collaborator = (CollaboratorPool.prototype as unknown as { _childPanelId(o: object, s: object, n: number): string })
      ._childPanelId.call(null, { panelId: 'panel', runId: 'run-1' }, { collaboratorId: 'critic' }, 0);
    const mention = 'panel-subagent-claude-code'; // MentionRouter.processMentions: `${panelId}-subagent-${agentId}`
    for (const child of [brainstorm, collaborator, mention]) {
      expect(child).not.toBe('panel');
      expect((await h.turn(child)).report).toMatchObject({ ok: false, token: null, error: 'no canvas mcp config' });
    }
    const again = await h.turn();
    expect(again.report).toMatchObject({ ok: true, pid: parent.report!.pid });
    expect(h.provider.children.get('panel')).toHaveLength(1);
  });

  it('natural completion refuses the credential yet an accessory send reuses the warm process', async () => {
    const h = await harness();
    const turn = {};
    await h.admitTurn(turn);
    const first = await h.turn();
    expect(first.report).toMatchObject({ ok: true });
    h.mcp.revoke(turn); // what the host does when the turn settles
    const accessory = await h.turn('panel', '/compact');
    expect(accessory.report!.pid).toBe(first.report!.pid);
    expect(accessory.report!.ok).toBe(false); // the late call is refused
    expect(accessory.chunks.filter(c => c.type === 'error')).toHaveLength(0);
    expect(h.provider.children.get('panel')).toHaveLength(1);

    await h.admitTurn({});
    const next = await h.turn();
    expect(next.report).toMatchObject({ ok: true, token: `Bearer ${h.endpoints[1].token}`, resume: 'fixture-session' });
  });
});
