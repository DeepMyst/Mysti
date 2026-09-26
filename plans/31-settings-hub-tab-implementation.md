# Settings Hub Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings, Personas & skills, Badges and About open in one reusable "Mysti" editor tab, bound to the chat that opened it, instead of stacking over the chat; the ⋯ menu gets text labels.

**Architecture:** The tab is the existing chat webview (`media/chat/index.html` + `chat.js` + `chat.css`) booted with `body.view-hub`, where CSS shows one of the four existing panels beside a nav. The host keeps it OUT of `_panelStates` and acts as a proxy: an allowlist of what the tab may send (re-bound to the origin chat via `bindIncomingMessage`), an allowlist of what the tab also hears, and a `settingsSync` message so the chat and tab never disagree about settings (the chat posts its own copy of `state.settings` with every message).

**Tech Stack:** TypeScript (extension host, strict), plain ES5-style JS in `media/chat/chat.js`, Vitest (unit + Playwright/Chromium browser suites), `tests/helpers/mockVscode.ts` aliased as `vscode`.

**Spec:** `plans/31-settings-hub-tab.md` — read it first; this plan argues from it.

## Global Constraints

- Every new source file carries the Apache-2.0 header used in `src/chat/incomingMessage.ts`.
- Private members use a leading underscore; logs use the `[Mysti]` prefix.
- The tab is NEVER registered in `_panelStates`.
- The tab may send only `HUB_INBOUND_TYPES`; when unbound only `HUB_UNBOUND_TYPES`. Everything else is dropped silently.
- `getWebviewContent` default output (no `view` option) stays byte-identical to today.
- Existing element ids in `index.html` do not change (handlers and tests bind them).
- No new npm dependencies. Do not lower lint rules.
- Run `npm test` and `npm run typecheck` before starting and after the last task; `npm run lint` must pass.

## Review Focus

1. **The tab changes the agent or a setting, then the user sends from the chat** → the send carries the new value, not the chat's stale copy. Pinned by Task 3 (host routes `settingsSync` to the origin only) and Task 6 (browser: `settingsSync` then Enter → `sendMessage.payload.settings`).
2. **The origin chat starts/switches/forks a conversation while the tab is open** → the tab shows the new conversation's title and personas & skills. Pinned by Task 3 ("follows its chat to a new conversation").
3. **Two quick clicks on a ⋯ item before the tab has loaded** → exactly one tab. Pinned by Task 2.
4. **Two chats open, tab bound to one** → the other chat never receives `settingsSync` or anything triggered by the tab, and its own settings changes do not reach the tab. Pinned by Task 3.
5. **The bound chat closes, then the user edits in the tab** → nothing is applied to any chat (not silently to the sidebar); About/Badges links still work. Pinned by Task 3 (unbound drops `updateSettings`/`updateAgentConfig`, honours `openExternal`) and Task 5 (`hub-unbound` makes Settings and Personas read-only).

---

### Task 1: The trust boundary — `src/chat/settingsHub.ts`

**Files:**
- Create: `src/chat/settingsHub.ts`
- Test: `tests/chat/settingsHub.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type HubSection = 'settings' | 'agents' | 'badges' | 'about'`; `HUB_INBOUND_TYPES`, `HUB_UNBOUND_TYPES`, `HUB_MIRROR_TYPES: ReadonlySet<string>`; `isHubSection(value: unknown): value is HubSection`.

- [ ] **Step 1: Write the failing test**

`tests/chat/settingsHub.test.ts`:

```ts
/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { HUB_INBOUND_TYPES, HUB_MIRROR_TYPES, HUB_UNBOUND_TYPES, isHubSection } from '../../src/chat/settingsHub';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Plan 31 — what the Mysti tab may say for its chat', () => {
  it('is exactly what the four panels send', () => {
    expect([...HUB_INBOUND_TYPES].sort()).toEqual([
      'createAgent', 'getBadgeShareText', 'importSkills', 'openConnections', 'openExternal',
      'requestAgentLists', 'requestBadges', 'requestModels', 'updateAgentConfig', 'updateSettings',
    ]);
  });

  it.each([
    'sendMessage', 'permissionResponse', 'cancelRequest', 'newConversation', 'autonomyLevelChanged',
    'uiReady', 'openSettingsHub', 'toggleAutonomous', 'confirmAutonomousActivation', 'askUserQuestionResponse',
    // Sent only by the chat-output refusal card, which the tab never renders.
    'openSettingKey',
  ])('never includes %s', (type) => {
    expect(HUB_INBOUND_TYPES.has(type)).toBe(false);
  });

  it('keeps only chat-free types once the chat is gone', () => {
    expect([...HUB_UNBOUND_TYPES].sort()).toEqual(['openConnections', 'openExternal']);
    for (const t of HUB_UNBOUND_TYPES) { expect(HUB_INBOUND_TYPES.has(t)).toBe(true); }
  });

  it('lists only types the host handles and the webview really sends', () => {
    const host = read('src/providers/ChatViewProvider.ts');
    const web = read('media/chat/chat.js');
    for (const t of HUB_INBOUND_TYPES) {
      expect(host, `host has no case for ${t}`).toContain(`case '${t}'`);
      expect(web, `chat.js never sends ${t}`).toContain(`type: '${t}'`);
    }
  });
});

describe('Plan 31 — what the Mysti tab hears from its chat', () => {
  it('is panel data only', () => {
    expect([...HUB_MIRROR_TYPES].sort()).toEqual([
      'agentChanged', 'agentConfigUpdated', 'agentsUpdated', 'badgeShareCopied', 'badgesUpdate',
      'manifestUpdated', 'modelChanged', 'modelsUpdated', 'providerAvailability', 'providerSwitched',
      'settingsError',
    ]);
  });

  it.each(['responseChunk', 'messageAdded', 'permissionRequest', 'initialState', 'responseStarted', 'settingsSync'])(
    'never copies %s', (type) => { expect(HUB_MIRROR_TYPES.has(type)).toBe(false); },
  );
});

describe('isHubSection', () => {
  it.each(['settings', 'agents', 'badges', 'about'])('accepts %s', (s) => { expect(isHubSection(s)).toBe(true); });
  it.each(['connections', '', 'SETTINGS', null, undefined, 1, {}])('rejects %j', (s) => { expect(isHubSection(s)).toBe(false); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chat/settingsHub.test.ts`
Expected: FAIL — cannot resolve `../../src/chat/settingsHub`.

- [ ] **Step 3: Write the module**

`src/chat/settingsHub.ts`:

```ts
/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 31 — the Mysti tab is the chat webview in a hub layout, acting for the
 * chat that opened it. These lists are the whole boundary between the two:
 * what the tab may say on the chat's behalf, and what the chat is told that
 * the tab also needs to hear.
 */

export type HubSection = 'settings' | 'agents' | 'badges' | 'about';

const HUB_SECTIONS: ReadonlySet<string> = new Set<HubSection>(['settings', 'agents', 'badges', 'about']);

/**
 * Webview → host types the tab may send; each is re-bound to the origin chat.
 * A type belongs here only if a control inside one of the four panels sends
 * it. Everything else — sendMessage, permissionResponse, autonomyLevelChanged
 * (posted by initializeState itself), uiReady, openSettingKey (the chat-output
 * refusal card's button) — is dropped, so a hidden card or a boot side effect
 * in the tab can never act for the chat.
 */
export const HUB_INBOUND_TYPES: ReadonlySet<string> = new Set([
  'updateSettings', 'requestModels', 'updateAgentConfig', 'requestAgentLists',
  'createAgent', 'importSkills', 'requestBadges', 'getBadgeShareText',
  'openExternal', 'openConnections',
]);

/** The subset that needs no chat, still honoured after the origin chat closes. */
export const HUB_UNBOUND_TYPES: ReadonlySet<string> = new Set(['openExternal', 'openConnections']);

/** Host → origin-chat types the tab also receives. Chat output never is. */
export const HUB_MIRROR_TYPES: ReadonlySet<string> = new Set([
  'modelsUpdated', 'providerAvailability', 'manifestUpdated', 'agentConfigUpdated',
  'agentsUpdated', 'badgesUpdate', 'badgeShareCopied', 'settingsError',
  'providerSwitched', 'agentChanged', 'modelChanged',
]);

export function isHubSection(value: unknown): value is HubSection {
  return typeof value === 'string' && HUB_SECTIONS.has(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/chat/settingsHub.test.ts`
Expected: PASS. If "lists only types the host handles" fails for a type, STOP and report — the spec's list was verified on 2026-09-26 and a miss means the code moved.

- [ ] **Step 5: Commit**

```bash
git add src/chat/settingsHub.ts tests/chat/settingsHub.test.ts
git commit -m "feat(hub): the Mysti tab's trust boundary (Plan 31)"
```

---

### Task 2: Host — open, reuse, rebind and unbind the tab

**Files:**
- Modify: `src/webview/webviewContent.ts` (`getWebviewContent` signature + tail)
- Modify: `src/providers/ChatViewProvider.ts` — imports (near line 20), fields (near `_vtDashboardPanelId`, ~line 401), `_sendInitialState` (~line 1208), sidebar `onDidDispose` (~line 1188), `_handleMessage` (next to `case 'openConnections'`), `openInNewTab` dispose (~line 13837), new methods after `openInNewTab`
- Test: `tests/webview/webviewContentHubView.test.ts`, `tests/integration/settingsHubTab.test.ts`

**Interfaces:**
- Consumes: `isHubSection`, `HubSection` (Task 1).
- Produces:
  - `getWebviewContent(webview, extensionUri, version = '0.0.0', opts: { view?: 'hub' } = {}): string`
  - `ChatViewProvider._hub: { panel: vscode.WebviewPanel; originPanelId: string | null } | null`
  - `public async openSettingsHub(section: HubSection, originPanelId: string): Promise<void>`
  - `private _postHubShow(section: HubSection | null): void` — posts `{ type: 'hubShow', payload: { section, chatTitle: string | null } }`; `chatTitle === null` means unbound.
  - `private _unbindHubFrom(panelId: string): void`
  - `private async _sendInitialState(panelId: string, forHub = false)`
  - `private async _receiveHubMessage(message: unknown, sender: vscode.Webview): Promise<void>` — declared here as a stub that returns; Task 3 fills it.
  - Chat → host message `{ type: 'openSettingsHub', payload: { section } }`.

- [ ] **Step 1: Write the failing webview-content test**

`tests/webview/webviewContentHubView.test.ts`:

```ts
/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWebviewContent } from '../../src/webview/webviewContent';

const ROOT = path.resolve(__dirname, '../..');
const webview = {
  cspSource: 'csp',
  asWebviewUri: (u: { fsPath: string }) => ({ toString: () => u.fsPath }),
} as unknown as vscode.Webview;
const ext = vscode.Uri.file(ROOT) as unknown as vscode.Uri;

describe('Plan 31 — getWebviewContent view option', () => {
  it('leaves the chat page untouched by default', () => {
    const html = getWebviewContent(webview, ext, '1');
    expect(html).toContain('<body>');
    expect(html).not.toContain('<body class="view-hub">');
  });

  it('marks the Mysti tab page', () => {
    expect(getWebviewContent(webview, ext, '1', { view: 'hub' })).toContain('<body class="view-hub">');
  });
});
```

- [ ] **Step 2: Write the failing lifecycle test**

`tests/integration/settingsHubTab.test.ts` (Task 3 appends to this file — keep the harness exported-free and at the top):

```ts
/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 31 — the Mysti tab: one editor tab, bound to the chat that opened it,
 * acting for that chat through an allowlist.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import type { WebviewMessage } from '../../src/types';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: vi.fn(() => '<html></html>') }));

type Listener = (value: unknown) => unknown;

function fakePanel() {
  const on: { message?: Listener; dispose?: () => void } = {};
  const webview = {
    html: '',
    postMessage: vi.fn(async (_m: unknown) => true),
    onDidReceiveMessage: (cb: Listener) => { on.message = cb; return { dispose() { /* noop */ } }; },
  };
  const panel = {
    webview,
    iconPath: undefined as unknown,
    reveal: vi.fn(),
    onDidDispose: (cb: () => void) => { on.dispose = cb; return { dispose() { /* noop */ } }; },
  };
  return { panel, webview, on };
}

interface HubProvider {
  _hub: { panel: unknown; originPanelId: string | null } | null;
  openSettingsHub(section: string, originPanelId: string): Promise<void>;
  _unbindHubFrom(panelId: string): void;
  _handleMessage(message: WebviewMessage): Promise<void>;
  _receiveHubMessage(message: unknown, sender: unknown): Promise<void>;
  _receivePanelMessage(message: unknown, panelId: string, sender: unknown): Promise<void>;
  _postToPanel(panelId: string, message: WebviewMessage): Promise<unknown>;
  _broadcastToAll(message: WebviewMessage): void;
}

const win = vscode.window as unknown as Record<string, unknown>;
const originalCreate = win.createWebviewPanel;
afterEach(() => { win.createWebviewPanel = originalCreate; });

const typesOf = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map(c => (c[0] as WebviewMessage).type);

function harness(overrides: Record<string, unknown> = {}) {
  const created: Array<ReturnType<typeof fakePanel>> = [];
  win.createWebviewPanel = vi.fn(() => {
    const p = fakePanel();
    created.push(p);
    return p.panel;
  });
  const chat = (id: string, conversation: string) => ({
    id, currentConversationId: conversation as string | null, isSidebar: id === 'sidebar',
    webview: { postMessage: vi.fn(async (_m: unknown) => true) },
  });
  const panels = new Map([['sidebar', chat('sidebar', 'c-side')], ['tab', chat('tab', 'c-tab')]]);
  const titles: Record<string, string> = { 'c-side': 'Fix login', 'c-tab': 'Refactor', 'c-new': 'New chat' };
  const sendInitialState = vi.fn(async (_panelId: string, _forHub?: boolean) => undefined);
  const provider = Object.assign(Object.create(ChatViewProvider.prototype), {
    _hub: null,
    _sidebarId: 'sidebar',
    _extensionUri: vscode.Uri.file('/mock'),
    _extensionContext: { extension: { packageJSON: { version: '0.0.0' } } },
    _panelStates: panels,
    _conversationManager: { getConversation: (id: string) => (titles[id] ? { id, title: titles[id] } : null) },
    _sendInitialState: sendInitialState,
    ...overrides,
  }) as unknown as HubProvider;
  const hubPosts = () => created[created.length - 1].webview.postMessage.mock.calls.map(c => c[0] as WebviewMessage);
  return { provider, created, panels, sendInitialState, hubPosts };
}

describe('Plan 31 — the Mysti tab lifecycle', () => {
  it('opens one tab beside the chat, on the requested section, bound to the opener', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    expect(h.created).toHaveLength(1);
    expect(win.createWebviewPanel).toHaveBeenCalledWith(
      'mysti.settingsHub', 'Mysti', vscode.ViewColumn.Beside,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    expect(h.sendInitialState).toHaveBeenCalledWith('sidebar', true);
    expect(h.hubPosts()).toContainEqual({ type: 'hubShow', payload: { section: 'settings', chatTitle: 'Fix login' } });
  });

  it('reuses the tab from the same chat without re-sending state', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    await h.provider.openSettingsHub('badges', 'sidebar');
    expect(h.created).toHaveLength(1);
    expect(h.created[0].panel.reveal).toHaveBeenCalled();
    expect(h.sendInitialState).toHaveBeenCalledTimes(1);
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'badges', chatTitle: 'Fix login' } });
  });

  it('rebinds to another chat that opens it', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    await h.provider.openSettingsHub('agents', 'tab');
    expect(h.created).toHaveLength(1);
    expect(h.provider._hub!.originPanelId).toBe('tab');
    expect(h.sendInitialState).toHaveBeenLastCalledWith('tab', true);
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'agents', chatTitle: 'Refactor' } });
  });

  it('opens exactly one tab when two clicks land before the first finishes loading', async () => {
    const h = harness();
    await Promise.all([h.provider.openSettingsHub('settings', 'sidebar'), h.provider.openSettingsHub('about', 'sidebar')]);
    expect(h.created).toHaveLength(1);
  });

  it('ignores an opener that is not a live chat', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'gone');
    expect(h.created).toHaveLength(0);
  });

  it('names an untitled chat rather than showing it as unbound', async () => {
    const h = harness();
    h.panels.get('tab')!.currentConversationId = 'missing';
    await h.provider.openSettingsHub('settings', 'tab');
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'settings', chatTitle: 'Untitled chat' } });
  });

  it('unbinds when its own chat closes, and only then', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    h.provider._unbindHubFrom('tab');
    expect(h.provider._hub!.originPanelId).toBe('sidebar');
    h.provider._unbindHubFrom('sidebar');
    expect(h.provider._hub!.originPanelId).toBeNull();
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: null, chatTitle: null } });
  });

  it('forgets the tab when the user closes it, and opens a fresh one next time', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    h.created[0].on.dispose!();
    expect(h.provider._hub).toBeNull();
    await h.provider.openSettingsHub('settings', 'sidebar');
    expect(h.created).toHaveLength(2);
  });

  it('opens from a chat message only for the four known sections', async () => {
    const h = harness();
    await h.provider._handleMessage({ type: 'openSettingsHub', payload: { section: 'badges' }, panelId: 'tab' } as WebviewMessage);
    expect(h.created).toHaveLength(1);
    await h.provider._handleMessage({ type: 'openSettingsHub', payload: { section: 'connections' }, panelId: 'tab' } as WebviewMessage);
    await h.provider._handleMessage({ type: 'openSettingsHub', payload: {}, panelId: 'tab' } as WebviewMessage);
    expect(h.hubPosts().filter(m => m.type === 'hubShow')).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run tests/webview/webviewContentHubView.test.ts tests/integration/settingsHubTab.test.ts`
Expected: FAIL — `view-hub` not in output; `openSettingsHub is not a function`.

- [ ] **Step 4: Add the view option to `getWebviewContent`**

In `src/webview/webviewContent.ts`, change the signature:

```ts
export function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  version: string = '0.0.0',
  opts: { view?: 'hub' } = {},
): string {
```

and replace the tail

```ts
  let html = _loadHtmlTemplate(extensionUri);
  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
```

with

```ts
  let html = _loadHtmlTemplate(extensionUri);
  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  // Plan 31: the Mysti tab is this same page in a hub layout (chat.css `.view-hub`).
  if (opts.view === 'hub') {
    html = html.replace('<body>', '<body class="view-hub">');
  }
  return html;
```

- [ ] **Step 5: Add the import and the field**

In `src/providers/ChatViewProvider.ts`, after `import { bindIncomingMessage } from '../chat/incomingMessage';` add:

```ts
import { isHubSection, type HubSection } from '../chat/settingsHub';
```

After `private _vtDashboardChatOrigin: string | null = null;` add:

```ts
  /** Plan 31: the Mysti tab, and the chat it acts for (null once that chat closes). Never in `_panelStates`. */
  private _hub: { panel: vscode.WebviewPanel; originPanelId: string | null } | null = null;
```

- [ ] **Step 6: Let `_sendInitialState` target the tab**

Change the signature to `private async _sendInitialState(panelId: string, forHub = false) {` and make these four edits inside it:

1. Wrap the context restore:

```ts
    if (!forHub) {
      void this._contextManager.restorePanelContext(panelId)
        .then((items) => {
          if (items.length) {
            this._postToPanel(panelId, { type: 'contextUpdated', payload: items });
          }
        })
        .catch(() => { /* best-effort */ });
    }
```

2. The wizard condition becomes `if (!forHub && !wizardDismissed && !wizardStatus.anyReady && !mystiReady) {`.

3. The demotion notice condition becomes `if (!forHub && demotedFrom && demotedFrom !== selectedProvider) {`.

4. Replace `this._postToPanel(panelId, {\n      type: 'initialState',` with `const initialState: WebviewMessage = {\n      type: 'initialState',`, change the payload line `conversation,` to `conversation: forHub ? undefined : conversation,`, change that object's closing `});` to `};`, and follow it with:

```ts
    if (forHub) {
      // Plan 31: the tab gets the chat's settings — not its transcript, and none
      // of the chat's side effects below (active mode, checkpoints, in-app messages).
      void Promise.resolve(this._hub?.panel.webview.postMessage(initialState)).catch(() => false);
      return;
    }
    this._postToPanel(panelId, initialState);
```

`agentConfig: conversation?.agentConfig` stays as is — the tab needs it.

- [ ] **Step 7: Add the lifecycle methods**

Directly after the closing `}` of `openInNewTab()` add:

```ts
  /**
   * Plan 31: open (or reveal) the Mysti tab on `section`, acting for the chat
   * `originPanelId`. There is one tab; opening it from another chat rebinds it.
   * `_hub` is assigned BEFORE the first await, so a second click that lands
   * while the first is still loading reveals the same tab.
   */
  public async openSettingsHub(section: HubSection, originPanelId: string): Promise<void> {
    if (!this._panelStates.has(originPanelId)) { return; }
    let rebind = true;
    if (this._hub) {
      rebind = this._hub.originPanelId !== originPanelId;
      this._hub.originPanelId = originPanelId;
      this._hub.panel.reveal();
    } else {
      const panel = vscode.window.createWebviewPanel('mysti.settingsHub', 'Mysti', vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
        retainContextWhenHidden: true,
      });
      panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'Mysti-Logo.png');
      const version = this._extensionContext.extension.packageJSON.version || '0.0.0';
      panel.webview.html = getWebviewContent(panel.webview, this._extensionUri, version, { view: 'hub' });
      panel.webview.onDidReceiveMessage((message: unknown) => this._receiveHubMessage(message, panel.webview));
      panel.onDidDispose(() => {
        if (this._hub?.panel === panel) { this._hub = null; }
      });
      this._hub = { panel, originPanelId };
    }
    if (rebind) { await this._sendInitialState(originPanelId, true); }
    this._postHubShow(section);
  }

  /** Plan 31: tell the tab which section to show and which chat it acts for (`chatTitle: null` = none). */
  private _postHubShow(section: HubSection | null): void {
    if (!this._hub) { return; }
    const origin = this._hub.originPanelId;
    const conversationId = origin ? this._panelStates.get(origin)?.currentConversationId : null;
    const chatTitle = origin
      ? (conversationId ? this._conversationManager.getConversation(conversationId)?.title : undefined) || 'Untitled chat'
      : null;
    void Promise.resolve(this._hub.panel.webview.postMessage({ type: 'hubShow', payload: { section, chatTitle } }))
      .catch(() => false);
  }

  /** Plan 31: the chat the tab acts for is gone — the tab stays, read-only. */
  private _unbindHubFrom(panelId: string): void {
    if (!this._hub || this._hub.originPanelId !== panelId) { return; }
    this._hub.originPanelId = null;
    this._postHubShow(null);
  }

  /** Plan 31: a message from the Mysti tab (routing lands in Task 3). */
  private async _receiveHubMessage(_message: unknown, _sender: vscode.Webview): Promise<void> {
    return;
  }
```

- [ ] **Step 8: Unbind on chat dispose, and handle the chat's request**

In the sidebar `webviewView.onDidDispose` callback, inside the `if (this._panelStates.get(this._sidebarId)?.webview === webviewView.webview) {` block, after `this._panelStates.delete(this._sidebarId);` add:

```ts
        this._unbindHubFrom(this._sidebarId);
```

In `openInNewTab`'s `panel.onDidDispose` callback, after `this._panelStates.delete(panelId);` add:

```ts
      this._unbindHubFrom(panelId);
```

In `_handleMessage`, directly after the `case 'openConnections': ... break;` block add:

```ts
      case 'openSettingsHub': {
        // Plan 31: a ⋯ item in a chat — open the Mysti tab acting for that chat.
        const section = (msg.payload as { section?: unknown } | undefined)?.section;
        if (isHubSection(section)) { await this.openSettingsHub(section, msg.panelId); }
        break;
      }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/webview/webviewContentHubView.test.ts tests/integration/settingsHubTab.test.ts && npm run typecheck`
Expected: PASS, tsc 0 errors. (If ESLint later flags the unused `_message`/`_sender` params, Task 3 removes the stub anyway.)

- [ ] **Step 10: Commit**

```bash
git add src/webview/webviewContent.ts src/providers/ChatViewProvider.ts tests/webview/webviewContentHubView.test.ts tests/integration/settingsHubTab.test.ts
git commit -m "feat(hub): open one Mysti tab bound to the chat that asked (Plan 31)"
```

---

### Task 3: Host — what crosses between the tab and its chat

**Files:**
- Modify: `src/providers/ChatViewProvider.ts` — the settingsHub import, `_receivePanelMessage` (~line 1504), the `_receiveHubMessage` stub from Task 2, `_postToPanel` (~line 13916), `_broadcastToAll` (~line 14094)
- Test: `tests/integration/settingsHubTab.test.ts` (append)

**Interfaces:**
- Consumes: `HUB_INBOUND_TYPES`, `HUB_UNBOUND_TYPES`, `HUB_MIRROR_TYPES` (Task 1); `_hub`, `_postHubShow`, `_unbindHubFrom`, `_sendInitialState(panelId, forHub)` (Task 2).
- Produces:
  - host → webview `{ type: 'settingsSync', payload: <the updateSettings payload verbatim> }` (Task 6 consumes it)
  - `private _mirrorToHub(panelId: string | null, message: WebviewMessage): void` (`null` = broadcast)
  - `private _syncHubSettings(originPanelId: string, payload: unknown, fromHub: boolean): void`
  - `private async _syncHubAfterChatMessage(panelId: string, bound: { type: string; payload?: unknown }, conversationBefore: string | null | undefined): Promise<void>`

- [ ] **Step 1: Append the failing tests**

Append to `tests/integration/settingsHubTab.test.ts`:

```ts
describe('Plan 31 — what crosses between the tab and its chat', () => {
  async function bound() {
    const handleMessage = vi.fn(async (_m: unknown) => undefined);
    const h = harness({ _handleMessage: handleMessage });
    await h.provider.openSettingsHub('settings', 'sidebar');
    const hub = h.created[0];
    const fromHub = (m: unknown) => h.provider._receiveHubMessage(m, hub.webview);
    return { ...h, hub, fromHub, handleMessage };
  }

  it('applies a settings change from the tab as its chat, and tells only that chat', async () => {
    const t = await bound();
    await t.fromHub({ type: 'updateSettings', payload: { thinkingLevel: 'high' }, panelId: 'forged' });
    expect(t.handleMessage).toHaveBeenCalledWith({ type: 'updateSettings', payload: { thinkingLevel: 'high' }, panelId: 'sidebar' });
    expect(t.panels.get('sidebar')!.webview.postMessage).toHaveBeenCalledWith({ type: 'settingsSync', payload: { thinkingLevel: 'high' } });
    expect(t.panels.get('tab')!.webview.postMessage).not.toHaveBeenCalled();
    expect(typesOf(t.hub.webview.postMessage)).not.toContain('settingsSync');
  });

  it('re-binds persona and skill edits to its chat', async () => {
    const t = await bound();
    await t.fromHub({ type: 'updateAgentConfig', payload: { personaId: 'p', enabledSkills: [] } });
    expect(t.handleMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'updateAgentConfig', panelId: 'sidebar' }));
  });

  it.each([
    'sendMessage', 'permissionResponse', 'cancelRequest', 'newConversation',
    'autonomyLevelChanged', 'uiReady', 'openSettingsHub', 'toggleAutonomous',
  ])('never lets the tab send %s', async (type) => {
    const t = await bound();
    await t.fromHub({ type, payload: {} });
    expect(t.handleMessage).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 42, 'updateSettings', [], {}, { type: 7 }])('drops a malformed message: %j', async (m) => {
    const t = await bound();
    await t.fromHub(m);
    expect(t.handleMessage).not.toHaveBeenCalled();
  });

  it('drops a message from any webview that is not the tab', async () => {
    const t = await bound();
    await t.provider._receiveHubMessage({ type: 'updateSettings', payload: {} }, t.panels.get('tab')!.webview);
    expect(t.handleMessage).not.toHaveBeenCalled();
  });

  it('after its chat closes, applies no edit anywhere but still opens links', async () => {
    const t = await bound();
    t.provider._unbindHubFrom('sidebar');
    await t.fromHub({ type: 'updateSettings', payload: { thinkingLevel: 'high' } });
    await t.fromHub({ type: 'updateAgentConfig', payload: {} });
    expect(t.handleMessage).not.toHaveBeenCalled();
    await t.fromHub({ type: 'openExternal', payload: 'https://example.com' });
    expect(t.handleMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'openExternal' }));
  });

  it('treats a chat that vanished without a dispose event as closed', async () => {
    const t = await bound();
    t.panels.delete('sidebar');
    await t.fromHub({ type: 'updateSettings', payload: {} });
    expect(t.handleMessage).not.toHaveBeenCalled();
  });

  it('copies a settings change made in its chat to the tab', async () => {
    const t = await bound();
    await t.provider._receivePanelMessage({ type: 'updateSettings', payload: { model: 'm2' } }, 'sidebar', t.panels.get('sidebar')!.webview);
    expect(t.hub.webview.postMessage).toHaveBeenCalledWith({ type: 'settingsSync', payload: { model: 'm2' } });
  });

  it('ignores settings changes in a chat it is not bound to', async () => {
    const t = await bound();
    await t.provider._receivePanelMessage({ type: 'updateSettings', payload: { model: 'm2' } }, 'tab', t.panels.get('tab')!.webview);
    expect(typesOf(t.hub.webview.postMessage)).not.toContain('settingsSync');
  });

  it('follows its chat to a new conversation', async () => {
    const t = await bound();
    t.handleMessage.mockImplementation(async () => { t.panels.get('sidebar')!.currentConversationId = 'c-new'; });
    t.sendInitialState.mockClear();
    await t.provider._receivePanelMessage({ type: 'newConversation' }, 'sidebar', t.panels.get('sidebar')!.webview);
    expect(t.sendInitialState).toHaveBeenCalledWith('sidebar', true);
    expect(t.hub.webview.postMessage).toHaveBeenLastCalledWith({ type: 'hubShow', payload: { section: null, chatTitle: 'New chat' } });
  });

  it('does not refresh when the conversation did not change', async () => {
    const t = await bound();
    t.sendInitialState.mockClear();
    await t.provider._receivePanelMessage({ type: 'requestBadges' }, 'sidebar', t.panels.get('sidebar')!.webview);
    expect(t.sendInitialState).not.toHaveBeenCalled();
  });

  it("mirrors panel data for its chat, never chat output or another chat's data", async () => {
    const t = await bound();
    t.hub.webview.postMessage.mockClear();
    await t.provider._postToPanel('sidebar', { type: 'agentConfigUpdated', payload: {} });
    await t.provider._postToPanel('sidebar', { type: 'responseChunk', payload: {} });
    await t.provider._postToPanel('tab', { type: 'modelsUpdated', payload: {} });
    expect(typesOf(t.hub.webview.postMessage)).toEqual(['agentConfigUpdated']);
    expect(t.panels.get('sidebar')!.webview.postMessage).toHaveBeenCalledTimes(2);
  });

  it('hears broadcast panel data but is never treated as a chat', async () => {
    const t = await bound();
    t.hub.webview.postMessage.mockClear();
    t.provider._broadcastToAll({ type: 'agentsUpdated', payload: {} });
    t.provider._broadcastToAll({ type: 'activeModeActivity', payload: {} });
    expect(typesOf(t.hub.webview.postMessage)).toEqual(['agentsUpdated']);
    expect([...t.panels.keys()]).toEqual(['sidebar', 'tab']);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/integration/settingsHubTab.test.ts`
Expected: the Task 2 describe PASSES; most of the new describe FAILS (stub drops everything; no `settingsSync`; no mirroring).

- [ ] **Step 3: Widen the import**

Replace `import { isHubSection, type HubSection } from '../chat/settingsHub';` with:

```ts
import {
  HUB_INBOUND_TYPES, HUB_MIRROR_TYPES, HUB_UNBOUND_TYPES, isHubSection, type HubSection,
} from '../chat/settingsHub';
```

- [ ] **Step 4: Replace the `_receiveHubMessage` stub and add the helpers**

Replace the Task 2 stub (`/** Plan 31: a message from the Mysti tab (routing lands in Task 3). */` and its method) with:

```ts
  /**
   * Plan 31: a message from the Mysti tab. Applied AS the chat it acts for —
   * `bindIncomingMessage` stamps the origin's id, whatever the tab claimed —
   * and only for HUB_INBOUND_TYPES; with no live chat, only HUB_UNBOUND_TYPES
   * (links), so an edit is never applied to some other chat by default.
   */
  private async _receiveHubMessage(message: unknown, sender: vscode.Webview): Promise<void> {
    if (!this._hub || this._hub.panel.webview !== sender) { return; }
    const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined;
    if (typeof type !== 'string' || !HUB_INBOUND_TYPES.has(type)) { return; }
    const origin = this._hub.originPanelId;
    const live = origin && this._panelStates.has(origin) ? origin : null;
    const target = live ?? (HUB_UNBOUND_TYPES.has(type) ? this._sidebarId : null);
    if (!target) { return; }
    const bound = bindIncomingMessage(message, target);
    if (!bound) { return; }
    try {
      await this._handleMessage(bound as unknown as WebviewMessage);
      if (live && bound.type === 'updateSettings') { this._syncHubSettings(live, bound.payload, true); }
    } catch (error) {
      console.error('[Mysti] Mysti tab action failed:', bound.type, error instanceof Error ? error.name : 'Unknown error');
    }
  }

  /**
   * Plan 31: the chat posts its OWN copy of `state.settings` with every
   * message, so a change made on one side of the chat/tab pair must reach the
   * other or the chat's next send silently undoes it. Posted directly, not via
   * `_postToPanel`, so it is never mirrored back to the side that made it.
   */
  private _syncHubSettings(originPanelId: string, payload: unknown, fromHub: boolean): void {
    if (!this._hub || this._hub.originPanelId !== originPanelId) { return; }
    const target = fromHub ? this._panelStates.get(originPanelId)?.webview : this._hub.panel.webview;
    if (!target) { return; }
    void Promise.resolve(target.postMessage({ type: 'settingsSync', payload })).catch(() => false);
  }

  /** Plan 31: keep the Mysti tab in step with what its chat just did. */
  private async _syncHubAfterChatMessage(
    panelId: string,
    bound: { type: string; payload?: unknown },
    conversationBefore: string | null | undefined,
  ): Promise<void> {
    if (!this._hub || this._hub.originPanelId !== panelId) { return; }
    if (bound.type === 'updateSettings') { this._syncHubSettings(panelId, bound.payload, false); }
    // New / switch / delete / fork / import all land here as a changed id —
    // no list of message types to drift.
    if (this._panelStates.get(panelId)?.currentConversationId !== conversationBefore) {
      await this._sendInitialState(panelId, true);
      this._postHubShow(null);
    }
  }

  /** Plan 31: the tab hears what its chat hears — HUB_MIRROR_TYPES only. `null` = a broadcast. */
  private _mirrorToHub(panelId: string | null, message: WebviewMessage): void {
    if (!this._hub || !HUB_MIRROR_TYPES.has(message.type)) { return; }
    if (panelId !== null && this._hub.originPanelId !== panelId) { return; }
    void Promise.resolve(this._hub.panel.webview.postMessage(message)).catch(() => false);
  }
```

- [ ] **Step 5: Wire the chat entry point**

In `_receivePanelMessage`, replace

```ts
    try {
      await this._handleMessage(bound as unknown as WebviewMessage);
    } catch (error) {
```

with

```ts
    const conversationBefore = state.currentConversationId;
    try {
      await this._handleMessage(bound as unknown as WebviewMessage);
      await this._syncHubAfterChatMessage(panelId, bound, conversationBefore);
    } catch (error) {
```

- [ ] **Step 6: Wire the mirrors**

At the top of `_postToPanel`'s body (before `const state = ...`) add:

```ts
    this._mirrorToHub(panelId, message);
```

At the top of `_broadcastToAll`'s body add:

```ts
    this._mirrorToHub(null, message);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/settingsHubTab.test.ts tests/chat/settingsHub.test.ts && npm run typecheck`
Expected: PASS; tsc 0 errors.

- [ ] **Step 8: Run the neighbouring host suites (they stub `_postToPanel`/`_receivePanelMessage` paths)**

Run: `npx vitest run tests/integration`
Expected: PASS. A harness built with `Object.create(ChatViewProvider.prototype)` that calls the real `_postToPanel` or `_broadcastToAll` has no `_hub` field; `_mirrorToHub` reads `this._hub` as `undefined` and returns — if anything fails with `_hub`, report it rather than adding `_hub` to other harnesses.

- [ ] **Step 9: Commit**

```bash
git add src/providers/ChatViewProvider.ts tests/integration/settingsHubTab.test.ts
git commit -m "feat(hub): the tab acts for its chat through an allowlist, and stays in sync (Plan 31)"
```

---

### Task 4: Label the ⋯ menu

**Files:**
- Modify: `media/chat/index.html` (the eight buttons inside `#overflow-menu`)
- Modify: `media/chat/chat.css` (the `.overflow-menu .icon-btn` rule, ~line 9445)
- Test: `tests/webview/settingsHubBrowser.test.ts` (create — Tasks 5 and 6 append to it)

**Interfaces:**
- Consumes: nothing.
- Produces: `<span class="overflow-label">…</span>` inside each `#overflow-menu` button; the browser harness `openPage(view: 'chat' | 'hub')` with `posted(pg)`, `send(pg, msg)`, `pageErrors`.

- [ ] **Step 1: Create the browser test with the harness and the failing label test**

`tests/webview/settingsHubBrowser.test.ts`:

```ts
/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 31, in a real browser: the ⋯ menu, the Mysti tab (body.view-hub) and
 * settingsSync, against the REAL index.html + chat.css + chat.js with the
 * boot contract the extension provides. Harness follows
 * chatComposerBrowser.test.ts — read its NOTE on replacer functions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Page } from 'playwright';

const ROOT = path.resolve(__dirname, '../..');
let browser: Browser | undefined;
const dirs: string[] = [];
const pageErrors: string[] = [];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function bootPayload(): Record<string, unknown> {
  const boot: Record<string, unknown> = { mermaidUri: '', logoUri: '', version: '0.0.0-test', iconUris: {}, manifestSchemaVersion: 1 };
  for (const k of ['claude', 'gemini', 'cline', 'copilot', 'cursor', 'openclaw', 'opencode', 'ollama',
    'localai', 'qwen', 'hermes', 'continue', 'openrouter', 'kimi']) { boot[`${k}LogoUri`] = ''; }
  boot.openaiLogoLightUri = '';
  boot.openaiLogoDarkUri = '';
  return boot;
}

function composeHtml(view: 'chat' | 'hub'): string {
  let html = read('media/chat/index.html');
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, '');
  html = html
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace(/\{\{cspSource\}\}/g, "'self'")
    .replace(/\{\{resourceBase\}\}/g, '')
    .replace(/\{\{version\}\}/g, '0.0.0-test')
    .replace('<link rel="stylesheet" href="{{chatCssUri}}">', () => `<style>${read('media/chat/chat.css')}</style>`)
    .replace('<link rel="stylesheet" href="{{deskCssUri}}">', () => `<style>${read('media/chat/desk.css')}</style>`)
    .replace('{{bootJson}}', () => JSON.stringify(bootPayload()))
    .replace('</head>', () => '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>');
  if (view === 'hub') { html = html.replace('<body>', () => '<body class="view-hub">'); }
  for (const [tag, file] of [
    ['<script nonce="n" src="/dompurify.min.js"></script>', 'resources/dompurify.min.js'],
    ['<script nonce="n" src="/marked.min.js"></script>', 'resources/marked.min.js'],
    ['<script nonce="n" src="/prism-bundle.js"></script>', 'resources/prism-bundle.js'],
  ] as const) {
    html = html.replace(tag, () => `<script>${read(file)}</script>`);
  }
  const stub = `<script>
    window.__posted = [];
    window.acquireVsCodeApi = function () {
      return { postMessage: function (m) { window.__posted.push(m); }, getState: function () {}, setState: function () {} };
    };
  </script>`;
  const bootTag = '<script nonce="n">window.__MYSTI_BOOT__';
  if (!html.includes(bootTag)) { throw new Error('boot script tag not found — harness is out of date with index.html'); }
  html = html.replace(bootTag, () => `${stub}${bootTag}`);
  return html
    .replace('<script nonce="n" src="{{markdownRendererJsUri}}"></script>', () => `<script>${read('media/chat/markdownRenderer.js')}</script>`)
    .replace('<script nonce="n" src="{{subAgentCardsJsUri}}"></script>', () => `<script>${read('media/chat/subAgentCards.js')}</script>`)
    .replace('<script nonce="n" src="{{chatJsUri}}"></script>', () => `<script>${read('media/chat/chat.js')}</script>`)
    .replace('<script nonce="n" src="{{deskJsUri}}"></script>', () => `<script>${read('media/chat/desk.js')}</script>`);
}

const INITIAL_SETTINGS = {
  provider: 'claude-code', model: '', mode: 'ask-before-edit', thinkingLevel: 'none',
  effortLevel: 'high', accessLevel: 'ask-permission', contextMode: 'auto', autonomousMode: false,
};

async function send(pg: Page, msg: Record<string, unknown>): Promise<void> {
  await pg.evaluate((m) => { window.dispatchEvent(new MessageEvent('message', { data: m })); }, msg);
}

async function posted(pg: Page): Promise<Array<Record<string, unknown>>> {
  return pg.evaluate(() => (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted);
}

async function clearPosted(pg: Page): Promise<void> {
  await pg.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
}

/** A fresh page in the chat view or the Mysti tab view, after initialState. */
async function openPage(view: 'chat' | 'hub', extra: Record<string, unknown> = {}): Promise<Page> {
  const ctx = await browser!.newContext();
  const pg = await ctx.newPage();
  pg.on('pageerror', (err) => pageErrors.push(`${view}: ${String(err)}`));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-hub-'));
  dirs.push(dir);
  const file = path.join(dir, 'chat.html');
  fs.writeFileSync(file, composeHtml(view), 'utf8');
  await pg.setViewportSize({ width: 900, height: 700 });
  await pg.goto(`file://${file}`, { waitUntil: 'load' });
  await send(pg, { type: 'initialState', payload: { settings: { ...INITIAL_SETTINGS }, messages: [], context: [], conversations: [], ...extra } });
  return pg;
}

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  await browser?.close();
  for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
});

describe('Plan 31 — the ⋯ menu says what each item is', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('every item has a visible, non-empty label', async () => {
    const pg = await openPage('chat');
    try {
      await pg.click('#overflow-btn');
      const labels = await pg.$$eval('#overflow-menu > button', (btns) => btns
        .filter((b) => getComputedStyle(b).display !== 'none')
        .map((b) => {
          const l = b.querySelector('.overflow-label') as HTMLElement | null;
          return l && l.offsetWidth > 0 ? (l.textContent || '').trim() : '';
        }));
      expect(labels.length).toBeGreaterThanOrEqual(7);
      expect(labels.every((t) => t.length > 0)).toBe(true);
    } finally { await pg.context().close(); }
  }, 30000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/webview/settingsHubBrowser.test.ts`
Expected: FAIL — labels are `''` (no `.overflow-label`). If Chromium is not installed the test is SKIPPED: run `npx playwright install chromium` first; a skipped browser test is not a pass.

- [ ] **Step 3: Add the labels**

In `media/chat/index.html`, inside `#overflow-menu`, add a label as the last child of each button's SVG — i.e. immediately after each button's closing `</svg>`:

| button id | insert after `</svg>` |
|---|---|
| `new-tab-btn` | `<span class="overflow-label">Open in new tab</span>` |
| `export-conversation-btn` | `<span class="overflow-label">Export conversation</span>` |
| `active-mode-btn` | `<span class="overflow-label">Active Mode</span>` (before the existing `active-mode-btn-dot` span) |
| `agent-config-btn` | `<span class="overflow-label">Personas &amp; skills</span>` |
| `badges-btn` | `<span class="overflow-label">Badges</span>` |
| `about-btn` | `<span class="overflow-label">About</span>` |
| `connections-btn` | `<span class="overflow-label">Connections</span>` |
| `settings-btn` | `<span class="overflow-label">Settings</span>` |

Also update the comment above `#overflow-menu` by appending one line: `Plan 31: each item now carries its label; four of them open the Mysti tab.`

- [ ] **Step 4: Style them**

In `media/chat/chat.css` replace

```css
    .overflow-menu .icon-btn { width: 100%; justify-content: flex-start; }
```

with

```css
    .overflow-menu .icon-btn { width: 100%; justify-content: flex-start; gap: 8px; padding: 5px 8px; position: relative; }
    /* Plan 31: the menu says what each item is. */
    .overflow-label { font-size: 12px; white-space: nowrap; }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/webview/settingsHubBrowser.test.ts tests/webview/agentMenuLayoutBrowser.test.ts tests/webview/chatComposerBrowser.test.ts`
Expected: PASS (the two existing suites confirm nothing else moved).

- [ ] **Step 6: Commit**

```bash
git add media/chat/index.html media/chat/chat.css tests/webview/settingsHubBrowser.test.ts
git commit -m "feat(menu): label every ⋯ item (Plan 31)"
```

---

### Task 5: The Mysti tab view, and the chat's four items open it

**Files:**
- Modify: `media/chat/index.html` (hub chrome after `</header>`)
- Modify: `media/chat/chat.css` (append the hub layout block at the end of the file)
- Modify: `media/chat/chat.js` (replace the four panel toggles ~lines 2031–2094; add `case 'hubShow'` next to `case 'initialState'` ~line 4335)
- Test: `tests/webview/settingsHubBrowser.test.ts` (append)

**Interfaces:**
- Consumes: host messages `hubShow { section: 'settings'|'agents'|'badges'|'about'|null, chatTitle: string|null }` (Task 2); harness from Task 4.
- Produces: chat → host `{ type: 'openSettingsHub', payload: { section } }`; body class `hub-unbound`; panel class `hub-active`; in the tab, the Connections nav item posts `{ type: 'openConnections' }`.

- [ ] **Step 1: Append the failing browser tests**

Append to `tests/webview/settingsHubBrowser.test.ts`:

```ts
const SECTIONS: Array<[string, string, string]> = [
  ['settings-btn', 'settings', 'settings-panel'],
  ['agent-config-btn', 'agents', 'agent-config-panel'],
  ['badges-btn', 'badges', 'badges-panel'],
  ['about-btn', 'about', 'about-panel'],
];

describe('Plan 31 — in the chat, the four items open the Mysti tab', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('each posts openSettingsHub and nothing opens inline', async () => {
    const pg = await openPage('chat');
    try {
      for (const [btn, section, panel] of SECTIONS) {
        await clearPosted(pg);
        await pg.click('#overflow-btn');
        await pg.click(`#${btn}`);
        expect((await posted(pg)).filter((m) => m.type === 'openSettingsHub')).toEqual([
          { type: 'openSettingsHub', payload: { section }, panelId: null },
        ]);
        expect(await pg.$eval(`#${panel}`, (el) => getComputedStyle(el).display)).toBe('none');
      }
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('the chat never shows the tab chrome', async () => {
    const pg = await openPage('chat');
    try {
      expect(await pg.$eval('#hub-nav', (el) => getComputedStyle(el).display)).toBe('none');
      expect(await pg.$eval('#hub-binding', (el) => getComputedStyle(el).display)).toBe('none');
    } finally { await pg.context().close(); }
  }, 30000);
});

describe('Plan 31 — the Mysti tab', () => {
  const visiblePanels = (pg: Page) => pg.$$eval('#settings-panel, #agent-config-panel, #badges-panel, #about-panel',
    (els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id));

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows the nav and exactly one section, and none of the chat', async () => {
    const pg = await openPage('hub');
    try {
      expect(await pg.$eval('#hub-nav', (el) => getComputedStyle(el).display)).not.toBe('none');
      expect(await visiblePanels(pg)).toEqual(['settings-panel']);
      for (const sel of ['.header', '#workarea', '.input-area', '#overflow-menu', '#init-loading-overlay']) {
        expect(await pg.$eval(sel, (el) => getComputedStyle(el).display), sel).toBe('none');
      }
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('hubShow picks the section and names the chat', async () => {
    const pg = await openPage('hub');
    try {
      await clearPosted(pg);
      await send(pg, { type: 'hubShow', payload: { section: 'badges', chatTitle: 'Fix login' } });
      expect(await visiblePanels(pg)).toEqual(['badges-panel']);
      expect(await pg.textContent('#hub-binding')).toBe('Configuring: Fix login');
      expect((await posted(pg)).map((m) => m.type)).toContain('requestBadges');
      expect(await pg.$eval('.hub-nav-item.active', (el) => el.getAttribute('data-hub-section'))).toBe('badges');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('nav clicks switch sections; Connections opens its own tab', async () => {
    const pg = await openPage('hub');
    try {
      await pg.click('.hub-nav-item[data-hub-section="agents"]');
      expect(await visiblePanels(pg)).toEqual(['agent-config-panel']);
      await clearPosted(pg);
      await pg.click('.hub-nav-item[data-hub-connections]');
      expect((await posted(pg)).map((m) => m.type)).toContain('openConnections');
      expect(await visiblePanels(pg)).toEqual(['agent-config-panel']);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('when its chat closes it keeps the section, says so, and turns edits off', async () => {
    const pg = await openPage('hub');
    try {
      await send(pg, { type: 'hubShow', payload: { section: 'settings', chatTitle: 'Fix login' } });
      await send(pg, { type: 'hubShow', payload: { section: null, chatTitle: null } });
      expect(await visiblePanels(pg)).toEqual(['settings-panel']);
      expect(await pg.textContent('#hub-binding')).toMatch(/^No chat selected/);
      expect(await pg.$eval('#settings-panel', (el) => getComputedStyle(el).pointerEvents)).toBe('none');
      expect(await pg.$eval('#agent-config-panel', (el) => getComputedStyle(el).pointerEvents)).toBe('none');
      await send(pg, { type: 'hubShow', payload: { section: 'about', chatTitle: 'Refactor' } });
      expect(await pg.$eval('body', (el) => el.classList.contains('hub-unbound'))).toBe(false);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('stacks the nav above the section in a narrow tab', async () => {
    const pg = await openPage('hub');
    try {
      await pg.setViewportSize({ width: 400, height: 700 });
      const nav = await pg.$eval('#hub-nav', (el) => el.getBoundingClientRect().bottom);
      const panel = await pg.$eval('#settings-panel', (el) => el.getBoundingClientRect().top);
      expect(panel).toBeGreaterThanOrEqual(nav);
      expect(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('boots both views without throwing', async () => {
    expect(pageErrors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/webview/settingsHubBrowser.test.ts`
Expected: FAIL — `#hub-nav` does not exist; the ⋯ items still toggle panels inline.

- [ ] **Step 3: Add the tab chrome to `index.html`**

Directly after `    </header>` (and before the `Plan 28 Phase 5` comment above `#overflow-menu`) insert:

```html
    <!-- Plan 31: the Mysti tab's chrome. The tab is this same page with
         body.view-hub (webviewContent.ts), which hides the chat and shows these
         beside ONE of the four panels below. Hidden in the chat itself. -->
    <nav id="hub-nav" class="hub-nav" aria-label="Mysti sections">
      <button class="hub-nav-item" data-hub-section="settings">Settings</button>
      <button class="hub-nav-item" data-hub-section="agents">Personas &amp; skills</button>
      <button class="hub-nav-item" data-hub-connections="1">Connections</button>
      <button class="hub-nav-item" data-hub-section="badges">Badges</button>
      <button class="hub-nav-item" data-hub-section="about">About</button>
    </nav>
    <div id="hub-binding" class="hub-binding" role="status">No chat selected</div>
```

- [ ] **Step 4: Add the hub layout to `chat.css`**

Append at the end of `media/chat/chat.css`:

```css
    /* ===== Plan 31 — the Mysti tab (body.view-hub) =====
       One of the four panels at a time beside a nav, full height. Everything
       else on the page — the chat, its overlays, the setup screens — is off.
       The panels keep their `.hidden` class; `.hub-active` wins over it. */
    .hub-nav, .hub-binding { display: none; }
    body.view-hub > :not(#app):not(script) { display: none !important; }
    body.view-hub #app {
      display: grid;
      grid-template-columns: 190px minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
    }
    body.view-hub #app > * { display: none !important; }
    body.view-hub #app > .hub-nav {
      display: flex !important;
      flex-direction: column;
      gap: 2px;
      grid-row: 1 / 3;
      grid-column: 1;
      padding: 12px 8px;
      border-right: 1px solid var(--mysti-border);
    }
    body.view-hub #app > .hub-binding {
      display: block !important;
      grid-row: 1;
      grid-column: 2;
      padding: 10px 16px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--mysti-border);
    }
    body.view-hub #app > .hub-active {
      display: block !important;
      grid-row: 2;
      grid-column: 2;
      min-height: 0;
      max-height: none;
      overflow-y: auto;
      border-bottom: none;
    }
    .hub-nav-item {
      text-align: left;
      padding: 6px 10px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      font: inherit;
      cursor: pointer;
    }
    .hub-nav-item:hover { background: var(--vscode-list-hoverBackground); }
    .hub-nav-item:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .hub-nav-item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    /* No chat to apply an edit to: read, don't write. */
    body.view-hub.hub-unbound #settings-panel,
    body.view-hub.hub-unbound #agent-config-panel { pointer-events: none; opacity: .5; }
    @media (max-width: 480px) {
      body.view-hub #app { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); }
      body.view-hub #app > .hub-nav {
        grid-row: 1; flex-direction: row; flex-wrap: wrap;
        border-right: none; border-bottom: 1px solid var(--mysti-border);
      }
      body.view-hub #app > .hub-binding { grid-row: 2; grid-column: 1; }
      body.view-hub #app > .hub-active { grid-row: 3; grid-column: 1; }
    }
```

- [ ] **Step 5: Replace the four inline toggles in `chat.js`**

Replace the block that starts at `      settingsBtn.addEventListener('click', function() {` and ends at the closing `      }` of `      if (agentConfigBtn && agentConfigPanel) { ... }` (just before `      // Reset agent config`) with the code below. KEEP the three declarations `var agentConfigBtn`, `var agentConfigPanel`, `var configResetBtn` — `configResetBtn` is used right after.

```js
      // Agent config panel refs (the reset button below binds to them)
      var agentConfigBtn = document.getElementById('agent-config-btn');
      var agentConfigPanel = document.getElementById('agent-config-panel');
      var configResetBtn = document.getElementById('config-reset-btn');

      // ======================================================================
      // Plan 31 — the Mysti tab. In the chat these four open the tab (acting
      // for THIS chat) instead of stacking a panel over the transcript. The tab
      // is this same page with body.view-hub: one panel at a time beside a nav.
      // The host decides what the tab may send — see src/chat/settingsHub.ts.
      // ======================================================================
      var IS_HUB = document.body.classList.contains('view-hub');
      var HUB_PANELS = { settings: 'settings-panel', agents: 'agent-config-panel', badges: 'badges-panel', about: 'about-panel' };
      var hubSection = 'settings';

      function openHubSection(section) {
        postMessageWithPanelId({ type: 'openSettingsHub', payload: { section: section } });
      }
      settingsBtn.addEventListener('click', function() { openHubSection('settings'); });
      if (aboutBtn) { aboutBtn.addEventListener('click', function() { openHubSection('about'); }); }
      if (badgesBtn) { badgesBtn.addEventListener('click', function() { openHubSection('badges'); }); }
      if (agentConfigBtn) { agentConfigBtn.addEventListener('click', function() { openHubSection('agents'); }); }

      function refreshBadgesPanel() {
        // Render instantly from cache, then refresh in background
        if (cachedBadges && cachedBadgeCounts) {
          updateBadgesUI(cachedBadges, cachedBadgeCounts);
        } else {
          var sp = document.getElementById('badges-spinner');
          if (sp) { sp.classList.remove('hidden'); }
        }
        postMessageWithPanelId({ type: 'requestBadges' });
      }

      function showHubSection(section) {
        if (!HUB_PANELS[section]) { return; }
        hubSection = section;
        Object.keys(HUB_PANELS).forEach(function(key) {
          var el = document.getElementById(HUB_PANELS[key]);
          if (el) { el.classList.toggle('hub-active', key === section); }
        });
        document.querySelectorAll('.hub-nav-item[data-hub-section]').forEach(function(b) {
          b.classList.toggle('active', b.getAttribute('data-hub-section') === section);
        });
        if (section === 'badges') { refreshBadgesPanel(); }
      }

      /** Host → tab: which section, and which chat it acts for (`chatTitle: null` = none). */
      function handleHubShow(payload) {
        if (!IS_HUB || !payload) { return; }
        var bound = typeof payload.chatTitle === 'string';
        document.body.classList.toggle('hub-unbound', !bound);
        var label = document.getElementById('hub-binding');
        if (label) {
          label.textContent = bound
            ? 'Configuring: ' + payload.chatTitle
            : 'No chat selected — open this tab from a chat’s ⋯ menu to edit';
        }
        showHubSection(payload.section || hubSection);
      }

      if (IS_HUB) {
        var hubNav = document.getElementById('hub-nav');
        if (hubNav) {
          hubNav.addEventListener('click', function(e) {
            var item = e.target && e.target.closest ? e.target.closest('.hub-nav-item') : null;
            if (!item) { return; }
            if (item.hasAttribute('data-hub-connections')) {
              postMessageWithPanelId({ type: 'openConnections' });
              return;
            }
            showHubSection(item.getAttribute('data-hub-section'));
          });
        }
        showHubSection(hubSection);
      }
```

Then in `handleMessage`'s switch, directly before `          case 'initialState':` add:

```js
          case 'hubShow':
            handleHubShow(message.payload);
            break;
```

Note: `settingsPanel`, `aboutPanel` and `badgesPanel` are still declared near line 1188 and may be referenced elsewhere — leave those declarations alone. `cachedBadges`, `cachedBadgeCounts` and `updateBadgesUI` are declared later in the same function scope (`var` + function hoisting), which is why `refreshBadgesPanel` can call them.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/webview/settingsHubBrowser.test.ts tests/webview/chatComposerBrowser.test.ts tests/webview/agentMenuLayoutBrowser.test.ts`
Expected: PASS, including "boots both views without throwing".

- [ ] **Step 7: Lint the webview**

Run: `npm run lint`
Expected: PASS (check-provider-literals, core manifest, eslint src + media).

- [ ] **Step 8: Commit**

```bash
git add media/chat/index.html media/chat/chat.css media/chat/chat.js tests/webview/settingsHubBrowser.test.ts
git commit -m "feat(hub): the Mysti tab view; ⋯ items open it instead of stacking (Plan 31)"
```

---

### Task 6: `settingsSync` — the chat and the tab never disagree

**Files:**
- Modify: `media/chat/chat.js` — `initializeState` (~line 8554), new `applySettingsToControls()` and `applySettingsSync(p)` directly above it, `case 'settingsSync'` in `handleMessage`
- Test: `tests/webview/settingsHubBrowser.test.ts` (append)

**Interfaces:**
- Consumes: host → webview `{ type: 'settingsSync', payload }` where `payload` is an `updateSettings` payload verbatim (Task 3). Keys that can arrive: `provider`, `model`, `thinkingLevel`, `effortLevel`, `mode`, `accessLevel`, `contextMode`, `customModel`, `agents.autoSuggest`, `agents.maxTokenBudget`, `showSuggestions`, `brainstorm.agents`, `brainstorm.strategy`, `permission.timeoutBehavior`, `semiAutonomous.timeout`, `autonomous.safetyMode` (the last is config-only and ignored).
- Produces: `applySettingsToControls()` (no messages posted); `applySettingsSync(p)`.

- [ ] **Step 1: Append the failing browser tests**

```ts
describe('Plan 31 — settingsSync keeps the chat and the tab in step', () => {
  async function sendFromComposer(pg: Page, text: string): Promise<Record<string, unknown>> {
    await clearPosted(pg);
    await pg.fill('#message-input', text);
    await pg.keyboard.press('Enter');
    const sends = (await posted(pg)).filter((m) => m.type === 'sendMessage');
    expect(sends).toHaveLength(1);
    return (sends[0].payload as { settings: Record<string, unknown> }).settings;
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)("a change made in the tab rides the chat's next send", async () => {
    const pg = await openPage('chat');
    try {
      await send(pg, { type: 'settingsSync', payload: { thinkingLevel: 'high', mode: 'default', accessLevel: 'full-access' } });
      expect(await pg.$eval('#thinking-select', (el) => (el as HTMLSelectElement).value)).toBe('high');
      const settings = await sendFromComposer(pg, 'hello');
      expect(settings).toMatchObject({ thinkingLevel: 'high', mode: 'default', accessLevel: 'full-access' });
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('an agent chosen in the tab becomes the chat agent', async () => {
    const pg = await openPage('chat');
    try {
      await send(pg, { type: 'settingsSync', payload: { provider: 'openai-codex' } });
      const settings = await sendFromComposer(pg, 'hello');
      expect(settings.provider).toBe('openai-codex');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('updates the nested rows, and applying it posts nothing back', async () => {
    const pg = await openPage('hub', {
      permissionSettings: { timeoutBehavior: 'auto-reject', semiAutonomousTimeout: 60 },
      brainstormStrategy: 'quick',
    });
    try {
      await clearPosted(pg);
      await send(pg, { type: 'settingsSync', payload: {
        'permission.timeoutBehavior': 'auto-accept', 'semiAutonomous.timeout': 90, 'brainstorm.strategy': 'debate',
      } });
      expect(await pg.$eval('#timeout-behavior-select', (el) => (el as HTMLSelectElement).value)).toBe('auto-accept');
      expect(await pg.$eval('#semi-auto-timeout-input', (el) => (el as HTMLInputElement).value)).toBe('90');
      expect(await pg.$eval('#brainstorm-strategy-select', (el) => (el as HTMLSelectElement).value)).toBe('debate');
      expect(await posted(pg)).toEqual([]);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('initialState still reports the autonomy level exactly once', async () => {
    const pg = await openPage('chat', { permissionSettings: { timeoutBehavior: 'auto-reject', semiAutonomousTimeout: 60 } });
    try {
      expect((await posted(pg)).filter((m) => m.type === 'autonomyLevelChanged')).toHaveLength(1);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('ignores a malformed payload', async () => {
    const pg = await openPage('chat');
    try {
      await send(pg, { type: 'settingsSync', payload: null });
      await send(pg, { type: 'settingsSync', payload: 'thinkingLevel' });
      const settings = await sendFromComposer(pg, 'hello');
      expect(settings.thinkingLevel).toBe('none');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('still boots both views without throwing', async () => {
    expect(pageErrors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/webview/settingsHubBrowser.test.ts`
Expected: the new describe FAILS (`settingsSync` is an unknown message; the send still carries `thinkingLevel: 'none'`). The "exactly once" test should already PASS — it guards the extraction in Step 3.

- [ ] **Step 3: Extract `applySettingsToControls()` from `initializeState`**

Directly above `      function initializeState(payload) {` add the function below. Its body is the block of `initializeState` from `        thinkingSelect.value = state.settings.thinkingLevel;` through the closing `}` of `if (state.permissionSettings) { ... }`, MOVED here verbatim except that `updateContext(state.context);` and the `autonomyLevelChanged` post (with its comment) stay in `initializeState`. The result, generated from `chat.js` at plan time (2026-09-26) — if `initializeState` has changed since, move the current block by the same rule:

```js
      /**
       * Plan 31: paint every settings control from `state`. Shared by
       * initializeState and settingsSync. Posts NOTHING — the autonomy-level
       * report stays in initializeState, where it belongs to panel boot.
       */
      function applySettingsToControls() {
        thinkingSelect.value = state.settings.thinkingLevel;
        if (contextModeLabel) {
          contextModeLabel.textContent = state.settings.contextMode === 'auto' ? 'Auto' : 'Manual';
        }
        updateBehaviorIndicator();
        updateBehaviorHint();

        // Set agent based on provider setting
        // Brainstorm is an agent type, not a mode - user selects it from the agent dropdown
        if (state.settings.provider) {
          providerSelect.value = state.settings.provider;
          state.activeAgent = state.settings.provider;
          // W1: thinking selector visibility is capability-driven
          updateThinkingSectionVisibility(state.settings.provider);
          updateEffortSectionVisibility(state.settings.provider);
          // Show strategy chip if brainstorm is active
          updateStrategyIndicatorVisibility(state.settings.provider);
        }

        // Populate model dropdown based on selected provider
        if (state.providers && state.providers.length > 0) {
          var provider = state.providers.find(function(p) { return p.name === state.settings.provider; });
          if (provider) {
            modelSelect.innerHTML = provider.models.map(function(m) {
              return '<option value="' + m.id + '"' + (m.id === state.settings.model ? ' selected' : '') + '>' + m.name + '</option>';
            }).join('');
            // Append "Custom..." option
            modelSelect.innerHTML += '<option value="__custom__">Custom...</option>';
          }
        }

        // Restore custom model if set in provider settings
        if (state.providerSettings && state.providerSettings.customModel) {
          modelSelect.value = '__custom__';
          customModelSection.classList.remove('hidden');
          customModelInput.value = state.providerSettings.customModel;
        }

        // W4: render the selected provider's declarative settings sections
        // (values restored from state.providerSettings by settingKey)
        renderProviderSettingsSections(state.settings.provider);

        // Mirror model + effort into the prompt-box quick pickers now that both
        // the model list and the effort selector have been populated.
        syncInlineSelectors();

        // Update agent menu to match settings
        updateAgentMenuSelection();
        updateThemeAwareLogos();

        // Update provider availability (disable unavailable providers)
        updateProviderAvailability();

        // Initialize agent configuration
        if (state.availablePersonas && state.availableSkills) {
          // Set agentConfig from conversation or use default
          if (!state.agentConfig) {
            state.agentConfig = { personaId: null, enabledSkills: [] };
          }
          renderAgentConfigPanel();
        }

        // Initialize agent settings UI
        if (state.agentSettings) {
          updateAgentSettingsUI();
        }

        // Initialize brainstorm agents UI
        if (state.brainstormAgents) {
          updateBrainstormAgentsUI();
        }
        // Initialize brainstorm strategy dropdown
        if (state.brainstormStrategy && brainstormStrategySelect) {
          brainstormStrategySelect.value = state.brainstormStrategy;
          if (brainstormStrategyHint) {
            brainstormStrategyHint.textContent = strategyDescriptions[state.brainstormStrategy] || '';
          }
        }
        updateBrainstormSectionVisibility();

        // Initialize autonomous sub-settings (timeout behavior, safety, etc.)
        if (state.permissionSettings) {
          var tbSelect = document.getElementById('timeout-behavior-select');
          if (tbSelect) {
            // If semi-autonomous was set (meaning autonomous is active), show as auto-reject in the dropdown
            var tbValue = state.permissionSettings.timeoutBehavior;
            tbSelect.value = (tbValue === 'semi-autonomous') ? 'auto-reject' : (tbValue || 'auto-reject');
          }
          var saTimeoutInput = document.getElementById('semi-auto-timeout-input');
          if (saTimeoutInput) {
            saTimeoutInput.value = state.permissionSettings.semiAutonomousTimeout || 60;
          }
          // Autonomy sub-settings visibility depends on current autonomy level
          showAutonomySubSettings(state.autonomyLevel);
          updateAutonomyIndicator();
        }
      }
```

Then the corresponding part of `initializeState` becomes:

```js
        applyProviderManifest();

        applySettingsToControls();

        updateContext(state.context);

        if (state.permissionSettings) {
          // Send authoritative autonomy level to backend (prevents stale config issues)
          postMessageWithPanelId({
            type: 'autonomyLevelChanged',
            payload: { level: state.autonomyLevel }
          });
        }

        // Initialize sticky progress observer for scroll-aware sticking
```

(`applyProviderManifest();` and the sticky-progress comment are the existing anchors on either side — do not duplicate them.)

- [ ] **Step 4: Add `applySettingsSync` and the message case**

Directly above `applySettingsToControls` add:

```js
      /**
       * Plan 31: a setting changed on the other side of the chat/Mysti-tab pair.
       * The chat posts `state.settings` with every message, so a change it never
       * heard about would be silently undone by its next send. `p` is exactly
       * the `updateSettings` payload the other side sent.
       */
      function applySettingsSync(p) {
        if (!p || typeof p !== 'object') { return; }
        ['provider', 'model', 'thinkingLevel', 'effortLevel', 'mode', 'accessLevel', 'contextMode'].forEach(function(k) {
          if (p[k] !== undefined) { state.settings[k] = p[k]; }
        });
        if (p.customModel !== undefined) {
          state.providerSettings = Object.assign({}, state.providerSettings, { customModel: p.customModel });
        }
        var nested = {
          'agents.autoSuggest': ['agentSettings', 'autoSuggest'],
          'agents.maxTokenBudget': ['agentSettings', 'maxTokenBudget'],
          'showSuggestions': ['agentSettings', 'showSuggestions'],
          'permission.timeoutBehavior': ['permissionSettings', 'timeoutBehavior'],
          'semiAutonomous.timeout': ['permissionSettings', 'semiAutonomousTimeout']
        };
        Object.keys(nested).forEach(function(k) {
          if (p[k] === undefined) { return; }
          var patch = {};
          patch[nested[k][1]] = p[k];
          state[nested[k][0]] = Object.assign({}, state[nested[k][0]], patch);
        });
        if (p['brainstorm.agents'] !== undefined) { state.brainstormAgents = p['brainstorm.agents']; }
        if (p['brainstorm.strategy'] !== undefined) { state.brainstormStrategy = p['brainstorm.strategy']; }
        applySettingsToControls();
        // Mode/access also drive the composer's trust pill.
        if (p.mode !== undefined || p.accessLevel !== undefined) {
          renderModeOptions();
          syncUnattendedAvailability();
        }
      }
```

In `handleMessage`'s switch, next to the `case 'hubShow':` from Task 5, add:

```js
          case 'settingsSync':
            applySettingsSync(message.payload);
            break;
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/webview/settingsHubBrowser.test.ts tests/webview/chatComposerBrowser.test.ts`
Expected: PASS. If "a change made in the tab rides the chat's next send" fails on `mode`/`accessLevel`, or "an agent chosen in the tab" is blocked by a send-time availability check, find what `sendMessage` really reads and report it — do not weaken the `thinkingLevel`/`provider` assertions to make them pass.

- [ ] **Step 6: Commit**

```bash
git add media/chat/chat.js tests/webview/settingsHubBrowser.test.ts
git commit -m "feat(hub): settingsSync — a change on either side reaches the other (Plan 31)"
```

---

### Task 7: Full gate, docs, and the F5 check

**Files:**
- Modify: `CLAUDE.md` (Webview UI section — one bullet)
- Modify: `plans/31-settings-hub-tab.md` (Status line)

- [ ] **Step 1: Run the full gate**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green. Record the test-file / test counts in the commit message. Any failure outside the files this plan touched: STOP and report it with output — do not patch unrelated suites.

- [ ] **Step 2: Document the view**

In `CLAUDE.md`, under `## Webview UI`, after the bullet for `src/webview/webviewContent.ts` / `media/chat/`, add:

```markdown
- The **Mysti tab** (Plan 31) is that same page with `body.view-hub` (`getWebviewContent(..., { view: 'hub' })`): Settings / Personas & skills / Badges / About beside a nav, bound to the chat that opened it. It is NOT in `_panelStates`; what it may send and hear is `src/chat/settingsHub.ts`, and `settingsSync` keeps the chat's own `state.settings` copy current
```

- [ ] **Step 3: F5 smoke (manual — report results, do not skip silently)**

In the Extension Development Host:
1. Sidebar ⋯ → every item shows a label.
2. ⋯ → Settings: a "Mysti" tab opens beside, "Configuring: <this chat's title>", Settings section; nothing opened inside the sidebar.
3. ⋯ → Badges from the sidebar: same tab comes forward on Badges; no second tab.
4. In the tab, Settings → change Thinking to High; in the sidebar send "hi"; confirm the turn used it (Debug Console `[Mysti]` logs or the response attribution).
5. In the tab, Settings → switch the agent; the sidebar's agent pill changes.
6. Open a chat in a new tab (⋯ → Open in new tab), then ⋯ → Personas & skills there: the Mysti tab now names that chat.
7. Close that chat tab: the Mysti tab says "No chat selected" and its Settings are greyed out; About links still open.
8. In the sidebar start a new conversation with the Mysti tab bound to it: the title in the tab updates.

- [ ] **Step 4: Mark the spec implemented and commit**

Set the spec's Status line to `IMPLEMENTED <date> — F5 smoke: <passed | pending: which steps>`.

```bash
git add CLAUDE.md plans/31-settings-hub-tab.md
git commit -m "docs(plan-31): the Mysti tab is implemented"
```
