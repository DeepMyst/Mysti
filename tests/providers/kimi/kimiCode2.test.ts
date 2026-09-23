/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Kimi Code 2.x support, driven by payloads captured from the real
 * @moonshot-ai/kimi-code 2.0.2 and kimi-cli 1.51.0 binaries
 * (tests/fixtures/kimi/acpPayloads.json):
 *  - session/new → session/set_mode default before the first prompt, because
 *    2.0.2 applies an inherited `default_permission_mode = "yolo"` to ACP
 *    sessions while reporting `default` (witnessed: Bash ran unasked);
 *  - the selected model is applied with session/set_model, never ANTHROPIC_MODEL;
 *  - version-branched launch: kimi-cli 1.52.0 is a tombstone and is refused;
 *  - install / update / auth commands for both generations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { Writable } from 'node:stream';
import { TestableKimiProvider } from '../../helpers/providerFactory';
import { createKimiSession } from '../../helpers/sessionFactory';
import type { KimiCodeSessionState } from '../../../src/providers/kimi/KimiCodeProvider';
import { getProviderSelfUpdateCommand, getProviderNpmPackage } from '../../../src/providers/base/ProviderManifest';
import type { Settings, StreamChunk } from '../../../src/types';

type Frame = Record<string, unknown> & { id?: number; params?: Record<string, unknown>; result?: Record<string, unknown> };
const fixtures = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../fixtures/kimi/acpPayloads.json'), 'utf8')) as Record<string, Frame> & { versionLines: Record<string, string> };

function settings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'full-access',
    contextMode: 'auto', model: '', provider: 'kimi-code', ...overrides,
  } as Settings;
}

function setVersion(provider: TestableKimiProvider, version: string | null): void {
  (provider as unknown as { _cachedCliVersion: string | null })._cachedCliVersion = version;
}

describe('Kimi Code ACP session setup (2.0.2 / 1.51.0 payloads)', () => {
  let provider: TestableKimiProvider;
  let session: KimiCodeSessionState;
  let written: Frame[];

  beforeEach(() => {
    provider = new TestableKimiProvider();
    session = createKimiSession();
    written = [];
    session.persistentProcess = {
      stdin: new Writable({ write(chunk, _encoding, callback) {
        for (const line of String(chunk).split('\n').filter(Boolean)) { written.push(JSON.parse(line)); }
        callback();
      } }),
    } as unknown as ChildProcess;
  });

  /** Run the handshake up to the session/new response with the given result. */
  function handshake(s: Settings, sessionNew: Frame): StreamChunk | null {
    provider.buildPersistentCliArgs(s, session);
    provider.formatPersistentInput('write the marker', session);
    provider.parseStreamLine(JSON.stringify({ ...fixtures.v2_initialize, id: session.initializeId }), session);
    return provider.parseStreamLine(JSON.stringify({ ...sessionNew, id: session.sessionNewId }), session);
  }

  const methods = () => written.map(frame => frame.method);

  it('pins the ask-first default mode before the prompt when the agent offers yolo/auto/plan', () => {
    expect(handshake(settings(), fixtures.v2_sessionNew)).toBeNull();
    expect(methods()).toEqual(['session/new', 'session/set_mode']);
    const setMode = written[1];
    expect(setMode.params).toEqual({ sessionId: fixtures.v2_sessionNew.result!.sessionId, modeId: 'default' });

    // The real 2.0.2 set_mode answer is `{}`: not a turn boundary, and it releases the prompt.
    const answer = JSON.stringify({ ...fixtures.v2_setModeResult, id: setMode.id });
    expect(provider.isResponseBoundary(answer)).toBe(false);
    expect(provider.parseStreamLine(answer, session)).toBeNull();
    expect(methods()).toEqual(['session/new', 'session/set_mode', 'session/prompt']);
    expect((written[2].params as { prompt: Array<{ text: string }> }).prompt[0].text).toBe('write the marker');
  });

  it('a rejected set_mode ends the turn with an error and never sends the prompt', () => {
    handshake(settings(), fixtures.v2_sessionNew);
    const rejection = JSON.stringify({ jsonrpc: '2.0', id: written[1].id, error: { code: -32602, message: 'Unknown modeId: default' } });
    expect(provider.isResponseBoundary(rejection)).toBe(true);
    const chunk = provider.parseStreamLine(rejection, session);
    expect(chunk?.type).toBe('error');
    expect(chunk?.content).toContain('ask-first default mode');
    expect(chunk?.content).toContain('The prompt was not sent');
    expect(methods()).not.toContain('session/prompt');
  });

  it('kimi-cli 1.x (a single default mode, models instead of configOptions) goes straight to the prompt', () => {
    const legacy: Frame = { jsonrpc: '2.0', id: 0, result: {
      sessionId: 'legacy-1',
      modes: { availableModes: [{ id: 'default', name: 'Default' }], currentModeId: 'default' },
      models: { availableModels: [{ modelId: 'kimi-code/kimi-for-coding', name: 'kimi-for-coding' }], currentModelId: 'kimi-code/kimi-for-coding' },
    } };
    handshake(settings(), legacy);
    expect(methods()).toEqual(['session/new', 'session/prompt']);
    expect(session.reportedModels).toEqual(['kimi-code/kimi-for-coding']);
  });

  it('applies the selected model with session/set_model after set_mode (the real 2.0.2 aliases)', () => {
    handshake(settings({ model: 'fake2' }), fixtures.v2_sessionNew);
    provider.parseStreamLine(JSON.stringify({ ...fixtures.v2_setModeResult, id: written[1].id }), session);
    expect(methods()).toEqual(['session/new', 'session/set_mode', 'session/set_model']);
    expect(written[2].params).toEqual({ sessionId: fixtures.v2_sessionNew.result!.sessionId, modelId: 'fake2' });
    provider.parseStreamLine(JSON.stringify({ jsonrpc: '2.0', id: written[2].id, result: {} }), session);
    expect(methods()[3]).toBe('session/prompt');
  });

  it('resolves a bare id to the one reported managed alias, and skips set_model when it is already current', () => {
    const managed = structuredClone(fixtures.v2_sessionNew);
    const options = (managed.result!.configOptions as Array<Record<string, unknown>>);
    options[0].currentValue = 'kimi-code/kimi-for-coding';
    options[0].options = [{ value: 'kimi-code/kimi-for-coding', name: 'K2.7' }, { value: 'kimi-code/k3', name: 'K3' }];
    const answerSetMode = () => provider.parseStreamLine(JSON.stringify({ ...fixtures.v2_setModeResult, id: written[1].id }), session);
    handshake(settings({ model: 'k3' }), managed);
    answerSetMode();
    expect(written[2]).toMatchObject({ method: 'session/set_model', params: { modelId: 'kimi-code/k3' } });

    written.length = 0;
    handshake(settings({ model: 'kimi-for-coding' }), managed);
    answerSetMode();
    expect(methods()).toEqual(['session/new', 'session/set_mode', 'session/prompt']);
  });

  it('an unknown model fails the turn and names what Kimi offers', () => {
    handshake(settings({ model: 'no-such-model' }), fixtures.v2_sessionNew);
    provider.parseStreamLine(JSON.stringify({ ...fixtures.v2_setModeResult, id: written[1].id }), session);
    const chunk = provider.parseStreamLine(JSON.stringify({ jsonrpc: '2.0', id: written[2].id, error: { code: -32602, message: 'Model not found' } }), session);
    expect(chunk?.type).toBe('error');
    expect(chunk?.content).toContain('"no-such-model"');
    expect(chunk?.content).toContain('fake, fake2');
    expect(methods()).not.toContain('session/prompt');
  });

  it('lists the reported models for the registry and never injects a model env', async () => {
    expect(await provider.discoverModels(1000)).toBeNull();
    (provider as unknown as { _panelSessions: Map<string, KimiCodeSessionState> })._panelSessions.set(session.panelId, session);
    handshake(settings({ model: 'fake2' }), fixtures.v2_sessionNew);
    expect(await provider.discoverModels(1000)).toEqual([{ id: 'fake', name: 'fake' }, { id: 'fake2', name: 'fake2' }]);
    // Witnessed on 2.0.2: ANTHROPIC_MODEL is ignored, and KIMI_MODEL_NAME without
    // KIMI_MODEL_API_KEY aborts startup, so the spawn env carries neither.
    expect(provider.getExtraSpawnEnv(settings({ model: 'k3', routedModel: 'k3' }))).toEqual({});
    expect(provider.buildPersistentCliArgs(settings({ model: 'k3' }), session)).toEqual(['acp']);
  });

  it('maps the 2.0.2 unauthenticated session/new to an auth error with `kimi login`', () => {
    const chunk = handshake(settings(), fixtures.v2_sessionNew_unauthenticated);
    expect(chunk).toMatchObject({ type: 'auth_error', authCommand: 'kimi login', providerName: 'Kimi Code' });
    session.acpSessionId = null;
    expect(handshake(settings(), fixtures.v1_sessionNew_unauthenticated)).toMatchObject({ type: 'auth_error', authCommand: 'kimi login' });
  });

  it('reads 2.0.2 tool arguments from the content block (no rawInput) and routes the permission request through them', () => {
    const toolCall = fixtures.v2_toolCall;
    const chunk = provider.parseStreamLine(JSON.stringify(toolCall), session);
    expect(chunk?.toolCall).toMatchObject({ name: 'Bash', input: { command: 'echo witnessed > marker.txt' } });

    // The real request carries only toolCallId + title; the tracked kind decides.
    const request = fixtures.v2_requestPermission;
    session.acpAccessLevel = 'full-access';
    session.acpMode = 'default';
    provider.parseStreamLine(JSON.stringify(request), session);
    const reply = written.at(-1) as { id: number; result: { outcome: { optionId: string } } };
    expect(reply.id).toBe(0);
    expect(reply.result.outcome.optionId).toBe('approve_once');
  });

  it('the fallback runs `kimi --version`, a flag both generations accept (`acp --check` never existed)', () => {
    expect(provider.buildCliArgs(settings(), session)).toEqual(['--version']);
    const chunk = provider.parseStreamLine('2.0.2', session);
    expect(chunk?.type).toBe('error');
    expect(chunk?.content).toContain('kimi login');
    expect(chunk?.content).toContain('reports: 2.0.2');
  });
});

describe('Kimi Code launch policy by CLI generation', () => {
  async function run(version: string | null, s: Settings): Promise<{ chunks: StreamChunk[]; discovered: boolean }> {
    const provider = new TestableKimiProvider();
    setVersion(provider, version);
    let discovered = false;
    vi.spyOn(provider, 'getCliPath').mockImplementation(() => { discovered = true; throw new Error('stop after policy'); });
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('hi', [], s, null, undefined, 'policy')) { chunks.push(chunk); }
    provider.dispose();
    return { chunks, discovered };
  }

  it('refuses the kimi-cli 1.52.0 tombstone before launch and points at the installer', async () => {
    const { chunks, discovered } = await run(fixtures.versionLines['1.52.0'], settings());
    expect(discovered).toBe(false);
    expect(chunks.map(chunk => chunk.type)).toEqual(['error', 'done']);
    expect(JSON.stringify(chunks)).toContain('final Python release');
    expect(JSON.stringify(chunks)).toContain('code.kimi.com/kimi-code/install');
  });

  it.each([['2.0.2'], ['1.51.0'], [null]] as const)('launches %s (unknown version included)', async (label) => {
    const { discovered } = await run(label === null ? null : fixtures.versionLines[label], settings());
    expect(discovered).toBe(true);
  });

  it('restricted tiers stay refused on 2.x even with set_mode available', async () => {
    const { chunks, discovered } = await run('2.0.2', settings({ accessLevel: 'ask-permission' }));
    expect(discovered).toBe(false);
    expect(JSON.stringify(chunks)).toContain('This turn was not started');
  });
});

describe('Kimi Code install, update and auth commands', () => {
  const originalPlatform = process.platform;
  afterEach(() => { Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }); });
  const onPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  it('auth command is `kimi login` (bare `kimi` runs the installer on kimi-cli 1.52)', () => {
    expect(new TestableKimiProvider().getAuthCommand()).toBe('kimi login');
  });

  it.each([
    ['darwin', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'],
    ['linux', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'],
    ['win32', 'irm https://code.kimi.com/kimi-code/install.ps1 | iex'],
  ] as const)('install command on %s is the official installer', (platform, expected) => {
    onPlatform(platform);
    expect(new TestableKimiProvider().getInstallCommand()).toBe(expected);
  });

  it('offers npm @moonshot-ai/kimi-code on every OS and checks that package for updates', () => {
    const npm = new TestableKimiProvider().getInstallMethods().find(method => method.id === 'npm');
    expect(npm).toMatchObject({ command: 'npm install -g @moonshot-ai/kimi-code', platform: 'all' });
    expect(getProviderNpmPackage('kimi-code')).toBe('@moonshot-ai/kimi-code');
  });

  it.each([
    ['darwin', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'],
    ['linux', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'],
    ['win32', 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://code.kimi.com/kimi-code/install.ps1 | iex"'],
  ] as const)('updates 2.x with `kimi upgrade` and moves 1.x to Kimi Code with the installer on %s', (platform, installer) => {
    onPlatform(platform);
    expect(getProviderSelfUpdateCommand('kimi-code', fixtures.versionLines['2.0.2'])).toBe('kimi upgrade');
    expect(getProviderSelfUpdateCommand('kimi-code', undefined)).toBe('kimi upgrade');
    expect(getProviderSelfUpdateCommand('kimi-code', fixtures.versionLines['1.51.0'])).toBe(installer);
    expect(getProviderSelfUpdateCommand('kimi-code', fixtures.versionLines['1.52.0'])).toBe(installer);
  });
});
