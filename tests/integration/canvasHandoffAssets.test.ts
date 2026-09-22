/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 — the canvas HANDOFF paths that live in ChatViewProvider (R4 round 4).
 *
 *  - R4-3  Export / Present / capture shipped raw `asset://` refs and copied no
 *          assets, so every image was absent from the only artifact anyone else
 *          ever sees. The pure half is covered in `canvasExportService.test.ts`;
 *          what is asserted HERE is that the host actually reads the bytes off
 *          disk and hands the resolver over — a fix in the library that nobody
 *          calls is the exact shape of the original bug.
 *  - R4-4  `assetBaseUri` is baked into the shell once, at panel open, and the
 *          webview binds its `asset://` resolver from it at construction. A
 *          design switch left every ref in the NEW design resolving into the
 *          PREVIOUS design's assets directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The real PlanOptionManager constructs a ResponseClassifier, which spawns warm
// Claude CLI processes — never acceptable in a unit test run.
vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class {
    async classifyResponse() {
      return { hasPlanOptions: false, options: [], clarifyingQuestions: [] };
    }
  },
}));

import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { SlashCommandManager } from '../../src/managers/SlashCommandManager';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { clearMockConfig, Uri } from '../helpers/mockVscode';
import * as vscode from 'vscode';
import type { CanvasArtifact } from '../../src/types';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';

/** A 1×1 transparent PNG. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function createMockExtensionContext(): any {
  return {
    globalState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    workspaceState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    subscriptions: [] as { dispose(): void }[],
    extensionPath: path.resolve(__dirname, '../..'),
    extensionUri: Uri.file(path.resolve(__dirname, '../..')),
    extension: { packageJSON: { version: '0.0.0' } },
  };
}

/** A webview that records every html assignment, like the real panel does. */
function fakeWebview(): any {
  return {
    html: '',
    cspSource: 'vscode-webview://abc123',
    postMessage: () => Promise.resolve(true),
    asWebviewUri: (u: any) =>
      ({ toString: () => `https://file+.vscode-resource.vscode-cdn.net${u.fsPath ?? u.path}` }),
    onDidReceiveMessage: () => ({ dispose: () => {} }),
  };
}

function makeProvider(): any {
  const extensionContext = createMockExtensionContext();
  const noop = {} as any;
  const providerManager = {
    setNativeApprovalHandler: () => ({ dispose() {} }), setAgentContextManager: () => undefined,
    getProvider: vi.fn(() => ({ name: 'claude-code', models: [], defaultModel: 'm' })),
    getProviderInstance: () => undefined,
    getAllProviders: () => [],
    getAllProviderIds: vi.fn(() => ['claude-code', 'mysti']),
    getModelContextWindow: vi.fn(() => 200000),
    getModels: vi.fn(() => []),
    setCanvasMcpConfig: vi.fn(),
    cancelRequest: vi.fn(),
  } as any;
  const slashCommandManager = new SlashCommandManager({
    providerManager,
    contextManager: { getContext: () => [] } as any,
    conversationManager: { getCurrentConversation: () => null } as any,
    compactionManager: noop,
    memoryManager: noop,
    brainstormManager: noop,
  });
  return new ChatViewProvider({
    extensionUri: extensionContext.extensionUri,
    extensionContext,
    contextManager: { getContext: () => [], setAutoContext: () => undefined, clearPanelContext: () => undefined } as any,
    conversationManager: { getCurrentConversation: () => null, getConversation: vi.fn(() => null) } as any,
    providerManager,
    suggestionManager: noop,
    brainstormManager: noop,
    permissionManager: new PermissionManager('ask-permission'),
    setupManager: {
      getWizardStatus: async () => ({ anyReady: false, providers: [] }),
      getWizardStatusCached: () => ({ anyReady: false, providers: [], complete: false }),
      ensureProviderStatusFresh: async () => undefined,
      onWizardStatusUpdated: () => ({ dispose: () => {} }),
    } as any,
    telemetryManager: noop,
    autonomousManager: noop,
    memoryManager: { learnFromPermissionDecision: vi.fn() } as any,
    compactionManager: {
      getStrategy: vi.fn(() => 'client-summarize'),
      getUsage: vi.fn(() => ({ totalInputTokens: 0, totalOutputTokens: 0 })),
      getLastFill: vi.fn(() => null),
      resetUsage: vi.fn(),
      evaluateCompaction: vi.fn(() => ({ act: false, smart: false })),
      appendHistory: vi.fn(),
      isSmartActive: vi.fn(() => false),
    } as any,
    lifecycleManager: { onLifecycleEvent: () => undefined } as any,
    slashCommandManager,
    activeModeManager: {
      onStatusChanged: () => undefined,
      onChannelChanged: () => undefined,
      onActivity: () => undefined,
      subscribeToChannelEvents: () => () => undefined,
      isConnected: () => false,
      isInstalled: () => false,
    } as any,
    engagementManager: noop,
    projectContextManager: noop,
    visualTestManager: noop,
    modelRegistry: createModelRegistryStub() as any,
    checkpointManager: undefined as any
  });
}

describe('canvas handoff — assets and the open design', () => {
  let root: string;
  let out: string;
  let store: ArtifactStore;
  let provider: any;
  let artifact: CanvasArtifact;
  let ref: string;
  const originalWindow: Record<string, unknown> = {};

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-handoff-'));
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-handoff-out-'));
    store = new ArtifactStore({ getRoot: () => root });
    provider = makeProvider();

    artifact = store.createArtifact({ name: 'Brand', kind: 'screens' });
    const record = await store.addAsset(artifact, PNG_B64, 'image/png', { role: 'image' });
    ref = record!.ref;
    store.insertPage(artifact, store.makePage({
      mode: 'jsx',
      jsxSource: `function Page(){ return <div><img src="${ref}" /></div>; }`,
      actionTitle: 'Hero',
    }));
    await store.save(artifact);

    provider._canvasPanelId = 'canvas-panel';
    provider._canvasViewToken = 'tok-1';
    provider._panelStates.set('canvas-panel', {
      id: 'canvas-panel',
      webview: fakeWebview(),
      panel: { webview: fakeWebview(), reveal: () => undefined },
      currentConversationId: null,
      isSidebar: false,
    });

    provider._canvasBridge = provider._createCanvasBridge('canvas-panel');
    provider._canvasArtifactSession = provider._createCanvasArtifactSession(
      'canvas-panel', store, new CanvasOpExecutor(store, new CanvasJobRouter(() => {})),
      provider._canvasBridge, provider._panelStates.get('canvas-panel').panel.webview,
    );
    await provider._canvasArtifactSession.initialize();
    artifact = provider._canvasArtifact;

    for (const k of ['showOpenDialog', 'createWebviewPanel']) {
      originalWindow[k] = (vscode.window as any)[k];
    }
    (vscode.window as any).showOpenDialog = async () => [Uri.file(out)];
    (vscode.window as any).createWebviewPanel = () => ({
      webview: fakeWebview(),
      iconPath: undefined,
      onDidDispose: () => ({ dispose: () => {} }),
      dispose: () => undefined,
    });
  });

  afterEach(async () => {
    await provider._canvasArtifactSession.close();
    provider._canvasBridge.dispose();
    for (const [k, v] of Object.entries(originalWindow)) {
      if (v === undefined) { delete (vscode.window as any)[k]; }
      else { (vscode.window as any)[k] = v; }
    }
    clearMockConfig();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('R4-3 the exported bundle carries the image, not an unloadable asset:// token', async () => {
    await provider._exportCanvas();
    const page = fs.readFileSync(path.join(out, 'pages', 'page-0.html'), 'utf8');
    expect(page).toContain(`data:image/png;base64,${PNG_B64}`);
    expect(page).not.toContain('asset://');
  });

  it('R4-3 Present shows the same image the editor showed', async () => {
    const panels: any[] = [];
    (vscode.window as any).createWebviewPanel = () => {
      const p = { webview: fakeWebview(), iconPath: undefined, onDidDispose: () => ({ dispose: () => {} }) };
      panels.push(p);
      return p;
    };
    await provider._presentCanvas();
    expect(panels).toHaveLength(1);
    expect(panels[0].webview.html).toContain(`data:image/png;base64,${PNG_B64}`);
    expect(panels[0].webview.html).not.toContain('asset:');
  });

  it('R4-3 an asset missing from disk degrades to a missing image, never to "undefined"', async () => {
    const orphan = `asset://${artifact.id}/assets/0000000000000000.png`;
    artifact.pages[0].doc.children![0].props!.src = orphan;
    await provider._exportCanvas();
    const page = fs.readFileSync(path.join(out, 'pages', 'page-0.html'), 'utf8');
    // The ref survives verbatim (the pre-existing missing-image behaviour): it
    // does not become the string `undefined` in the middle of the document.
    const boot = JSON.parse(
      /id="__mysti_page_doc">(.*?)<\/script>/s.exec(page)![1],
    );
    expect(boot.doc.children[0].props.src).toBe(orphan);
  });

  it('R4-4 switching designs re-points the webview asset base at the NEW design', async () => {
    const other = store.createArtifact({ name: 'Second', kind: 'screens' });
    store.insertPage(other, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){return <div/>;}' }));
    await store.save(other);

    const panel = provider._panelStates.get('canvas-panel').panel;
    panel.webview.html = '';
    await provider._switchCanvasArtifact('canvas-panel', other.id);

    expect(provider._canvasArtifact.id).toBe(other.id);
    expect(panel.webview.html).toContain(other.id);
    expect(panel.webview.html).not.toContain(artifact.id);
  });

  it('R4-4 a brand-new design does not inherit the previous design`s assets dir', async () => {
    const panel = provider._panelStates.get('canvas-panel').panel;
    panel.webview.html = '';
    await provider._switchCanvasArtifact('canvas-panel', null, 'Fresh');
    expect(panel.webview.html).toContain(provider._canvasArtifact.id);
    expect(panel.webview.html).not.toContain(artifact.id);
  });

  // R8 export ownership: Export/Present act on the design they were REQUESTED
  // for, captured once as an immutable snapshot with its own store. A switch,
  // close or concurrent edit during the folder picker / asset reads cannot
  // retarget the bundle, crash it, or strip its images.
  describe('export/present ownership', () => {
    function deferredPick() {
      let resolve!: (value: unknown) => void;
      const promise = new Promise(yes => { resolve = yes; });
      (vscode.window as any).showOpenDialog = () => promise;
      return () => resolve([Uri.file(out)]);
    }
    const read = (file: string) => fs.readFileSync(path.join(out, file), 'utf8');

    it('exports the requested design when the view switches designs while the picker is open', async () => {
      const other = store.createArtifact({ name: 'Second design', kind: 'screens' });
      store.insertPage(other, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){return <div>second</div>;}' }));
      await store.save(other);
      const pick = deferredPick();
      const exporting = provider._exportCanvas();
      await provider._switchCanvasArtifact('canvas-panel', other.id);
      expect(provider._canvasArtifact.id).toBe(other.id);
      pick();
      await exporting;
      const title = /<title>([^<]*)<\/title>/.exec(read('index.html'))?.[1];
      expect(title).toContain('Brand');
      expect(title).not.toContain('Second design');
      expect(read(path.join('pages', 'page-0.html')).includes(`data:image/png;base64,${PNG_B64}`)).toBe(true);
    });

    it('finishes the requested export with its images when the view closes while the picker is open', async () => {
      const pick = deferredPick();
      const exporting = provider._exportCanvas();
      await provider._canvasArtifactSession.close();
      expect(provider._canvasArtifact).toBeNull();
      pick();
      await exporting;
      expect(/<title>([^<]*)<\/title>/.exec(read('index.html'))?.[1]).toContain('Brand');
      expect(read(path.join('pages', 'page-0.html')).includes(`data:image/png;base64,${PNG_B64}`)).toBe(true);
    });

    it('never pairs a later edit with asset bytes gathered for an earlier page list', async () => {
      const live = provider._canvasArtifact as CanvasArtifact;
      const second = await store.addAsset(live, PNG_B64.replace('C0', 'C1'), 'image/png', { role: 'image' });
      const readBytes = store.readAssetBytes.bind(store);
      let mutated = false;
      vi.spyOn(store, 'readAssetBytes').mockImplementation(async (assetRef: string) => {
        if (!mutated) {
          mutated = true;
          store.insertPage(live, store.makePage({
            mode: 'jsx', jsxSource: `function Page(){ return <img src="${second!.ref}" />; }`,
          }));
        }
        return readBytes(assetRef);
      });
      await provider._exportCanvas();
      const pages = fs.readdirSync(path.join(out, 'pages'));
      const unresolved = pages.filter(page => read(path.join('pages', page)).includes('asset://'));
      expect(unresolved).toEqual([]);
    });

    it('presents the requested design with its images when the view closes during preparation', async () => {
      const panels: any[] = [];
      (vscode.window as any).createWebviewPanel = () => {
        const p = { webview: fakeWebview(), iconPath: undefined, onDidDispose: () => ({ dispose: () => {} }) };
        panels.push(p);
        return p;
      };
      const presenting = provider._presentCanvas();
      await provider._canvasArtifactSession.close();
      await presenting;
      expect(panels).toHaveLength(1);
      expect(panels[0].webview.html.includes(`data:image/png;base64,${PNG_B64}`)).toBe(true);
    });
  });

  // R8 failed-close recovery: the host keeps a durable copy outside the failed
  // workspace store and says truthfully where it is, or that it was lost.
  describe('failed close recovery', () => {
    let storage: string;
    beforeEach(() => { storage = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-recovery-')); });
    afterEach(() => { vi.restoreAllMocks(); fs.rmSync(storage, { recursive: true, force: true }); });

    function closeWithFailedSave() {
      const live = provider._canvasArtifact as CanvasArtifact;
      live.name = 'Unsaved brand';
      provider._canvasArtifactSession.scheduleSave();
      vi.spyOn(store, 'save').mockRejectedValue(new Error('disk full'));
      const warn = vi.spyOn(vscode.window, 'showWarningMessage');
      return { live, warn, closing: provider._canvasArtifactSession.close() as Promise<void> };
    }

    it('writes a restorable recovery copy and names it in the only warning', async () => {
      provider._extensionContext.globalStorageUri = Uri.file(storage);
      const { live, warn, closing } = closeWithFailedSave();
      await closing;
      const dir = path.join(storage, 'canvas-recovery');
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      const copy = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      expect(copy).toMatchObject({ id: live.id, name: 'Unsaved brand', schemaVersion: 1 });
      expect(copy.pages).toHaveLength(live.pages.length);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain(path.join(dir, files[0]));
      expect(warn.mock.calls[0][0]).toContain('disk full');
    });

    it('shutdown closes the canvas and waits for its final save instead of dropping the debounce', async () => {
      const live = provider._canvasArtifact as CanvasArtifact;
      live.name = 'Edited just before quitting';
      provider._canvasArtifactSession.scheduleSave();
      let release!: () => void;
      const save = vi.spyOn(store, 'save').mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
      const panel = provider._panelStates.get('canvas-panel').panel;
      panel.dispose = vi.fn();
      let settled = false;
      const shutdown = (provider.closeCanvasForShutdown() as Promise<void>).then(() => { settled = true; });
      expect(panel.dispose).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledExactlyOnceWith(live, expect.any(Function));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      release();
      await shutdown;
    });

    it('says the edits were lost when the recovery copy cannot be written either', async () => {
      const blocked = path.join(storage, 'not-a-directory');
      fs.writeFileSync(blocked, '');
      provider._extensionContext.globalStorageUri = Uri.file(blocked);
      const { warn, closing } = closeWithFailedSave();
      await closing;
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/could not save "Unsaved brand".*unsaved changes were lost/);
    });
  });
});
