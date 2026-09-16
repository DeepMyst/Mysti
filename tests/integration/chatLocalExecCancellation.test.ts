import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { MystiLocalExec } from '../../src/services/MystiLocalExec';
import { MystiLocalTools } from '../../src/services/MystiLocalTools';
import { clearMockConfig, setMockConfig, workspace } from '../helpers/mockVscode';
import type { PermissionRequest, Settings, WebviewMessage } from '../../src/types';

const settings: Settings = {
  provider: 'mysti', model: 'fixture', thinkingLevel: 'medium', contextMode: 'manual',
  mode: 'ask-before-edit', accessLevel: 'ask-permission',
};
const entry = {
  name: 'fixture_run', description: 'Writes a fixture marker',
  inputSchema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string' } } },
  exec: { interpreter: 'node' as const, script: 'run.cjs' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(root: string) {
  const permissions = new PermissionManager('ask-permission');
  const cards: PermissionRequest[] = [];
  const waiters: Array<(card: PermissionRequest) => void> = [];
  const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
  const cancelled = new Set<string>();
  const executionAbort = new AbortController();
  const siblingAbort = new AbortController();
  const snapshot = vi.fn(async () => true);
  const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', sandboxed: true, timedOut: false }));
  const staged = path.join(root, 'staged');
  const installed = path.join(root, 'installed');
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(staged, 'mysti.tools.json'), JSON.stringify([entry]));
  fs.writeFileSync(path.join(staged, 'run.cjs'), "process.stdout.write('fixture');");
  fs.writeFileSync(path.join(root, 'target.txt'), 'before');
  const promote = vi.fn(async () => {
    await fs.promises.cp(staged, installed, { recursive: true });
    return { ok: true, installedTo: installed };
  });
  const register = vi.fn((value: unknown) => fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(value)));
  const verify = vi.fn(async (): Promise<string | null> => null);
  const record = vi.fn();
  const registry = {
    findEntry: () => ({ artifact: { id: 'fixture', dir: staged }, entry }),
    verify, register,
  };
  const reload = vi.fn(async () => undefined);
  const provider = Object.assign(Object.create(ChatViewProvider.prototype), {
    _permissionManager: permissions,
    _panelStates: new Map([['panel', { id: 'panel' }]]),
    _autonomousManager: { isActive: () => false },
    _jobCancelled: cancelled,
    _jobAbortControllers: new Map(),
    _mystiExecutionAborts: new Map([['job', executionAbort], ['other-job', siblingAbort]]),
    _mystiActiveDelegationRuns: new Map(),
    _backgroundJobManager: { get: (id: string) => ({ id, panelId: 'panel' }) },
    _collaboratorPool: { cancelRun: vi.fn() },
    _checkpointManager: { snapshot },
    _mystiLocalExec: new MystiLocalExec(new MystiLocalTools({ getWorkspaceRoot: () => root }), {
      available: () => true, resolveInterpreter: async () => process.execPath, run,
    }),
    _skillStaging: () => ({ list: async () => [{ id: 'fixture', dir: staged }], promote }),
    _capabilityRegistry: () => registry,
    _capabilityLedger: () => ({ isOffered: () => true, requiresForcedApproval: () => false, record }),
    _observedRuns: () => ({ goldensFor: () => [] }),
    reloadAgents: reload,
    _postToPanel: (panelId: string, message: WebviewMessage) => {
      posted.push({ panelId, message });
      if (message.type === 'permissionRequest') {
        const card = message.payload as PermissionRequest;
        const waiter = waiters.shift();
        if (waiter) { waiter(card); } else { cards.push(card); }
      }
    },
  });
  const nextCard = (): Promise<PermissionRequest> => cards.length
    ? Promise.resolve(cards.shift()!) : new Promise(resolve => waiters.push(resolve));
  const approve = (card: PermissionRequest) => permissions.handleResponse({ requestId: card.id, decision: 'approve' });
  const isCancelled = () => cancelled.has('job');
  const local = () => provider._runMystiLocalExec(
    { kind: 'write', path: 'target.txt', content: 'after' }, settings, 'panel', 'tool', 'job', isCancelled, executionAbort.signal,
  );
  const skill = () => provider._runMystiSkillRun(
    { kind: 'skillrun', tool: 'fixture_run', args: {} }, settings, 'panel', 'tool', 'job', isCancelled, executionAbort.signal,
  );
  const publish = () => provider._runMystiPublish('fixture', 'panel', 'tool', 'job', isCancelled, executionAbort.signal);
  return { provider, permissions, nextCard, approve, local, skill, publish, snapshot, run, promote, register, verify, record, reload, posted, cancelled, executionAbort, siblingAbort };
}

describe('host local execution Stop and permission ownership', () => {
  let root: string;
  let h: ReturnType<typeof harness>;
  const mutableWorkspace = workspace as unknown as { isTrusted?: boolean };
  let originalTrust: boolean | undefined;
  beforeEach(() => {
    clearMockConfig();
    setMockConfig('permission.timeout', 0);
    setMockConfig('permission.timeoutBehavior', 'require-action');
    setMockConfig('mysti.localExecution', 'on');
    originalTrust = mutableWorkspace.isTrusted;
    mutableWorkspace.isTrusted = true;
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mysti-stop-host-'));
    h = harness(root);
  });
  afterEach(() => {
    h.permissions.dispose();
    if (originalTrust === undefined) { delete mutableWorkspace.isTrusted; } else { mutableWorkspace.isTrusted = originalTrust; }
    clearMockConfig();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['local', 'skill', 'publish'] as const)('Stop cancels a %s card without any delegation, leaving sibling and foreground owners pending', async kind => {
    const foreground = h.provider.requestPermissionInline('file-edit', 'foreground', 'fixture', {}, 'panel', 'fg-tool');
    const foregroundCard = await h.nextCard();
    const sibling = h.provider.requestPermissionInline('file-edit', 'sibling', 'fixture', {}, 'panel', 'sibling-tool', 'other-job');
    const siblingCard = await h.nextCard();
    const pending = h[kind]();
    const card = await h.nextCard();
    expect(card).toMatchObject({ ownerKey: 'job', toolCallId: 'tool' });
    h.provider._abortMystiJob('job');
    expect(h.executionAbort.signal.aborted).toBe(true);
    expect(h.siblingAbort.signal.aborted).toBe(false);
    expect(await pending).toMatchObject({ ok: false, output: expect.stringMatching(/cancelled/) });
    expect(h.permissions.getPendingRequests().map(request => request.id).sort()).toEqual([foregroundCard.id, siblingCard.id].sort());
    expect(h.posted.filter(item => item.message.type === 'permissionDismissed')).toEqual([
      { panelId: 'panel', message: { type: 'permissionDismissed', payload: { requestIds: [card.id] } } },
    ]);
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, 'target.txt'), 'utf8')).toBe('before');
    expect(fs.existsSync(path.join(root, '.mysti', 'run'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'installed'))).toBe(false);
    h.approve(card); // stale user approval cannot restart the stopped tool.
    h.approve(foregroundCard); h.approve(siblingCard);
    expect(await Promise.all([foreground, sibling])).toEqual([true, true]);
  });

  it.each(['local', 'skill'] as const)('%s preserves the live owner predicate through an approved gate and pending checkpoint', async kind => {
    const entered = deferred<void>();
    const resume = deferred<boolean>();
    h.snapshot.mockImplementation(async () => { entered.resolve(); return resume.promise; });
    const pending = h[kind]();
    h.approve(await h.nextCard());
    await entered.promise;
    h.provider._abortMystiJob('job');
    h.cancelled.clear(); // The live signal remains stopped after transient flags reset.
    resume.resolve(true);
    expect(await pending).toMatchObject({ ok: false, output: expect.stringMatching(/cancelled/) });
    expect(fs.readFileSync(path.join(root, 'target.txt'), 'utf8')).toBe('before');
    expect(h.run).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.mysti', 'run'))).toBe(false);
    if (kind === 'skill') { expect(h.record).toHaveBeenCalledWith('fixture', 'neutral'); }
  });

  it('does not raise a skill card after Stop during registry verification', async () => {
    const entered = deferred<void>();
    const resume = deferred<string | null>();
    h.verify.mockImplementation(async () => { entered.resolve(); return resume.promise; });
    const pending = h.skill();
    await entered.promise;
    h.provider._abortMystiJob('job');
    resume.resolve(null);
    expect(await pending).toMatchObject({ ok: false, output: expect.stringMatching(/cancelled/) });
    expect(h.permissions.getPendingCount()).toBe(0);
    expect(h.posted).toEqual([]);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('binds the second publish card to the job and refuses promotion after Stop', async () => {
    const pending = h.publish();
    h.approve(await h.nextCard());
    const registerCard = await h.nextCard();
    expect(registerCard).toMatchObject({ ownerKey: 'job', toolCallId: 'tool', title: 'Register this capability' });
    h.provider._abortMystiJob('job');
    expect(await pending).toMatchObject({ ok: false, output: expect.stringMatching(/cancelled/) });
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'installed'))).toBe(false);
  });

  it('reports copied files but never registers a capability if Stop arrives during promotion', async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    const promote = h.promote.getMockImplementation()!;
    h.promote.mockImplementation(async () => {
      const result = await promote();
      entered.resolve(); await resume.promise; return result;
    });
    const pending = h.publish();
    h.approve(await h.nextCard()); h.approve(await h.nextCard());
    await entered.promise;
    h.provider._abortMystiJob('job');
    resume.resolve();
    expect(await pending).toMatchObject({ ok: false, output: expect.stringMatching(/Files remain.*not registered/) });
    expect(fs.existsSync(path.join(root, 'installed', 'run.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'registry.json'))).toBe(false);
    expect(h.register).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('can publish after both actual permission cards approve without Stop', async () => {
    const pending = h.publish();
    h.approve(await h.nextCard()); h.approve(await h.nextCard());
    expect(await pending).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(root, 'installed', 'run.cjs'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'))).toMatchObject({ id: 'fixture' });
    expect(h.reload).toHaveBeenCalledOnce();
  });
});
