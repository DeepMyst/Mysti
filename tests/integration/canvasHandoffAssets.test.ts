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
    setAgentContextManager: () => undefined,
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
  return new ChatViewProvider(
    extensionContext.extensionUri,
    extensionContext,
    { getContext: () => [], setAutoContext: () => undefined, clearPanelContext: () => undefined } as any,
    { getCurrentConversation: () => null, getConversation: vi.fn(() => null) } as any,
    providerManager,
    noop, noop,
    new PermissionManager('ask-permission'),
    {
      getWizardStatus: async () => ({ anyReady: false, providers: [] }),
      getWizardStatusCached: () => ({ anyReady: false, providers: [], complete: false }),
      ensureProviderStatusFresh: async () => undefined,
      onWizardStatusUpdated: () => ({ dispose: () => {} }),
    } as any,
    noop, noop,
    { learnFromPermissionDecision: vi.fn() } as any,
    {
      getStrategy: vi.fn(() => 'client-summarize'),
      getUsage: vi.fn(() => ({ totalInputTokens: 0, totalOutputTokens: 0 })),
      resetUsage: vi.fn(),
      evaluateCompaction: vi.fn(() => ({ act: false, smart: false })),
      appendHistory: vi.fn(),
      isSmartActive: vi.fn(() => false),
    } as any,
    { onLifecycleEvent: () => undefined } as any,
    slashCommandManager,
    {
      onStatusChanged: () => undefined,
      onChannelChanged: () => undefined,
      onActivity: () => undefined,
      subscribeToChannelEvents: () => () => undefined,
      isConnected: () => false,
      isInstalled: () => false,
    } as any,
    noop, noop, noop, noop, noop,
  );
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

    provider._canvasStore = store;
    provider._canvasExecutor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
    provider._canvasArtifact = artifact;
    provider._canvasPanelId = 'canvas-panel';
    provider._canvasViewToken = 'tok-1';
    provider._panelStates.set('canvas-panel', {
      id: 'canvas-panel',
      webview: fakeWebview(),
      panel: { webview: fakeWebview(), reveal: () => undefined },
      currentConversationId: null,
      isSidebar: false,
    });

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

  afterEach(() => {
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
});
