/**
 * Plan 14 / Plan 27 Phase 4: the collaboration slash commands (/consult,
 * /review, /critique, /panel).
 *
 * These used to post a `composeCollaboration` message prebound to a role, and
 * THIS FILE asserted that it was posted — without ever asserting anyone
 * received it. Nothing did: the webview picker it addressed was never built, so
 * all four menu entries silently did nothing while the suite stayed green. That
 * is the exact test shape that let eight dead menu entries survive, so the
 * assertions here are now about the OUTCOME (a composed @agent:role mention
 * reaching the input) rather than about a message leaving the manager.
 *
 * `tests/integration/slashCommandsAllLive.test.ts` holds the general property:
 * no menu entry may post a message nothing receives.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig, resetWindowStubs, window as mockWindow } from '../helpers/mockVscode';
import { SlashCommandManager } from '../../src/managers/SlashCommandManager';
import type { WebviewMessage } from '../../src/types';

function makeManager(): SlashCommandManager {
  // The collaboration cases only touch callbacks.postToPanel, so the heavy
  // manager deps can be stubbed.
  return new SlashCommandManager({
    // The composer asks the registry who is available, so a 16th backend needs
    // no edit here — and the picker never offers the agent you are already on.
    providerManager: {
      getAllProviders: () => ([
        { id: 'claude-code', displayName: 'Claude Code' },
        { id: 'google-gemini', displayName: 'Gemini' },
        { id: 'openai-codex', displayName: 'Codex' },
      ]),
    } as any,
    contextManager: {} as any,
    conversationManager: {} as any,
    compactionManager: {} as any,
    memoryManager: {} as any,
    brainstormManager: {} as any,
  });
}

function makeCallbacks(posted: Array<{ panelId: string; message: WebviewMessage }>) {
  return {
    postToPanel: (panelId: string, message: WebviewMessage) => posted.push({ panelId, message }),
    updateSettings: async () => {},
    getPanelProvider: () => 'claude-code',
    getPanelModel: () => 'model',
    getModelsForProvider: () => [],
    executeManualCompaction: async () => {},
  };
}

describe('collaboration slash commands', () => {
  let manager: SlashCommandManager;

  beforeEach(() => {
    clearMockConfig();
    resetWindowStubs();
    manager = makeManager();
  });

  it('/consult composes an @agent:role mention for the picked agent', async () => {
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    mockWindow.showQuickPick = async () => ([{ label: 'Gemini', id: 'google-gemini' }]);
    await manager.executeCommand('cmd:consult', 'is my caching safe?', 'panel-1', makeCallbacks(posted) as any);
    expect(posted).toHaveLength(1);
    // setInputValue IS handled by the webview; composeCollaboration never was.
    expect(posted[0].message.type).toBe('setInputValue');
    expect((posted[0].message.payload as { value: string }).value)
      .toBe('@google-gemini:advisor is my caching safe?');
  });

  it('/review binds the reviewer role', async () => {
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    mockWindow.showQuickPick = async () => ([{ label: 'Codex', id: 'openai-codex' }]);
    await manager.executeCommand('cmd:review', 'the diff', 'panel-1', makeCallbacks(posted) as any);
    expect((posted[0].message.payload as { value: string }).value).toBe('@openai-codex:reviewer the diff');
  });

  it('/critique binds the critic role', async () => {
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    mockWindow.showQuickPick = async () => ([{ label: 'Gemini', id: 'google-gemini' }]);
    await manager.executeCommand('cmd:critique', 'the migration plan', 'panel-1', makeCallbacks(posted) as any);
    expect((posted[0].message.payload as { value: string }).value).toBe('@google-gemini:critic the migration plan');
  });

  it('/panel composes one mention per picked agent', async () => {
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    mockWindow.showQuickPick = async () => ([
      { label: 'Gemini', id: 'google-gemini' },
      { label: 'Codex', id: 'openai-codex' },
    ]);
    await manager.executeCommand('cmd:panel', 'should we adopt X?', 'panel-1', makeCallbacks(posted) as any);
    expect((posted[0].message.payload as { value: string }).value)
      .toBe('@google-gemini:advisor @openai-codex:advisor should we adopt X?');
  });

  it('cancelling the picker posts NOTHING — no half-composed input', async () => {
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    mockWindow.showQuickPick = async () => undefined;
    await manager.executeCommand('cmd:consult', 'x', 'panel-1', makeCallbacks(posted) as any);
    expect(posted).toEqual([]);
  });

  it('the agent you are already talking to is not offered as a collaborator', async () => {
    let offered: Array<{ id: string }> = [];
    mockWindow.showQuickPick = async (items: unknown) => { offered = items as Array<{ id: string }>; return undefined; };
    // makeCallbacks reports the active provider as claude-code.
    await manager.executeCommand('cmd:consult', 'x', 'panel-1', makeCallbacks([]) as any);
    expect(offered.map(o => o.id)).toEqual(['google-gemini', 'openai-codex']);
  });

  it('says why when there is no one to collaborate with, rather than going quiet', async () => {
    const solo = new SlashCommandManager({
      providerManager: { getAllProviders: () => ([{ id: 'claude-code', displayName: 'Claude Code' }]) } as any,
      contextManager: {} as any, conversationManager: {} as any, compactionManager: {} as any,
      memoryManager: {} as any, brainstormManager: {} as any,
    });
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    const result = await solo.executeCommand('cmd:consult', 'x', 'panel-1', makeCallbacks(posted) as any);
    expect(result).toMatch(/No other agent is available/);
    expect(posted).toEqual([]);
  });

  it('resolves typed /consult to cmd:consult via the fallback mapping', () => {
    expect(manager.mapLegacyCommand('consult')).toBe('cmd:consult');
  });

  // Plan 29: review, critique and panel are SESSIONS now. Each used to compose
  // an `@agent:role` mention for the user to send; each now dispatches directly
  // and merges the answers, so a typed /review opens the agent picker rather
  // than pre-filling the composer. The mention grammar itself is unchanged.
  it('routes the names that became sessions to their session command', () => {
    expect(manager.mapLegacyCommand('review')).toBe('session:review');
    expect(manager.mapLegacyCommand('critique')).toBe('session:critique');
    expect(manager.mapLegacyCommand('panel')).toBe('session:panel');
    expect(manager.mapLegacyCommand('race')).toBe('session:race');
    expect(manager.mapLegacyCommand('brainstorm')).toBe('session:brainstorm');
  });
});

describe('isKnownCommand (native /command pass-through decision — Phase B)', () => {
  let manager: SlashCommandManager;
  beforeEach(() => { clearMockConfig(); manager = makeManager(); });

  it('recognizes a Mysti-owned universal command as known', () => {
    expect(manager.isKnownCommand('cmd:consult', 'p1', 'claude-code', makeCallbacks([]) as any)).toBe(true);
    expect(manager.isKnownCommand('cmd:help', 'p1', 'claude-code', makeCallbacks([]) as any)).toBe(true);
  });

  it('treats a native backend command as UNKNOWN (so it passes through)', () => {
    // Claude Code's own /deep-research, /skill-name, saved workflows: not Mysti's
    expect(manager.isKnownCommand('cmd:deep-research', 'p1', 'claude-code', makeCallbacks([]) as any)).toBe(false);
    expect(manager.isKnownCommand('cmd:some-skill', 'p1', 'claude-code', makeCallbacks([]) as any)).toBe(false);
  });

  it('treats :terminal launch commands as known', () => {
    expect(manager.isKnownCommand('claude-code:terminal', 'p1', 'claude-code', makeCallbacks([]) as any)).toBe(true);
  });
});
