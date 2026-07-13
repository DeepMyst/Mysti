/**
 * Plan 14: the collaboration slash commands (/consult, /review, /critique,
 * /panel) dispatch a composeCollaboration message prebound to the right role.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { SlashCommandManager } from '../../src/managers/SlashCommandManager';
import type { WebviewMessage } from '../../src/types';

function makeManager(): SlashCommandManager {
  // The collaboration cases only touch callbacks.postToPanel, so the heavy
  // manager deps can be stubbed.
  return new SlashCommandManager({
    providerManager: {} as any,
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
    manager = makeManager();
  });

  it('/consult posts composeCollaboration prebound to the advisor role', async () => {
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    await manager.executeCommand('cmd:consult', 'is my caching safe?', 'panel-1', makeCallbacks(posted) as any);
    expect(posted).toHaveLength(1);
    expect(posted[0].message.type).toBe('composeCollaboration');
    expect(posted[0].message.payload).toMatchObject({ role: 'advisor', brief: 'is my caching safe?' });
  });

  it('/review prebinds the reviewer role and targets the diff', async () => {
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    await manager.executeCommand('cmd:review', '', 'panel-1', makeCallbacks(posted) as any);
    expect(posted[0].message.payload).toMatchObject({ role: 'reviewer', target: 'diff' });
  });

  it('/critique prebinds the critic role', async () => {
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    await manager.executeCommand('cmd:critique', 'the migration plan', 'panel-1', makeCallbacks(posted) as any);
    expect(posted[0].message.payload).toMatchObject({ role: 'critic', brief: 'the migration plan' });
  });

  it('/panel marks the run as a panel', async () => {
    const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
    await manager.executeCommand('cmd:panel', 'should we adopt X?', 'panel-1', makeCallbacks(posted) as any);
    expect(posted[0].message.payload).toMatchObject({ panel: true, brief: 'should we adopt X?' });
  });

  it('resolves typed /consult to cmd:consult via the fallback mapping', () => {
    expect(manager.mapLegacyCommand('consult')).toBe('cmd:consult');
    expect(manager.mapLegacyCommand('review')).toBe('cmd:review');
    expect(manager.mapLegacyCommand('critique')).toBe('cmd:critique');
    expect(manager.mapLegacyCommand('panel')).toBe('cmd:panel');
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
