# Plan 31 — Settings Hub Tab

- **Date:** 2026-09-26
- **Status:** APPROVED 2026-09-26 — implementation plan: `plans/31-settings-hub-tab-implementation.md`
- **Trigger:** User report: clicking a ⋯ menu item opens an inline panel above the chat; with several things open the sidebar gets crowded and unreadable. Wanted: menu items open in a new tab, and a menu that is easier to work with.

Symbols are the stable reference; line numbers drift.

---

## Goal

Settings, Personas & skills, Badges and About leave the chat column. They open in one reusable **Mysti** editor tab with a left nav, bound to the chat that opened it. The transcript is never pushed down by a settings page again, and the ⋯ menu says what each item is.

## Decisions (made in chat, 2026-09-26)

| # | Question | Decision |
|---|---|---|
| D1 | Tab layout | **One Mysti tab** with a left nav; each ⋯ item deep-links to its section; reopening reveals the same tab. |
| D2 | Which chat do per-chat sections edit? | **The chat that opened it.** Header reads "Configuring: \<chat title\>"; opening from another chat's ⋯ menu rebinds. |
| D3 | Approach | **Hub view of the existing chat webview** (same `index.html`/`chat.js`/`chat.css`), not a second webview that re-implements the panels. |

## Current state (verified 2026-09-26)

- The ⋯ menu (`#overflow-menu`, `media/chat/index.html`) is eight **unlabeled** icon buttons.
- `#settings-panel`, `#agent-config-panel`, `#badges-panel`, `#about-panel` are block siblings between the header and `#workarea`, up to `60vh` each. The four toggle handlers in `chat.js` close each other, but they stack with the Active Mode strip, the Runs/Changes docks, the context panel and the suggestions rail.
- The ⌘K palette (`buildPaletteEntries` area) routes "Personas and skills" and "All settings…" by `.click()`-ing `#agent-config-btn` / `#settings-btn`.
- Settings are mixed-scope. `_handleUpdateSettings`: mode, thinking, effort, access → global config; model, provider → `panelState.settingsOverrides` (per panel). Agent config (`updateAgentConfig`) → the panel's current conversation.
- **The chat sends `state.settings` with every `sendMessage`.** A setting changed elsewhere and not merged into that chat's `state.settings` is silently overwritten by its next send. This is the constraint the sync in §Host drives from.
- Every control inside the four panels posts only: `updateSettings`, `requestModels`, `updateAgentConfig`, `requestAgentLists`, `createAgent`, `importSkills`, `requestBadges`, `getBadgeShareText`, `openExternal`, `openConnections`. (`openSettingKey` is sent only by the chat-output refusal card, which the hub never renders, so it is not on the list.) The autonomy **level** picker is in the composer popup, not the settings panel; the panel's autonomy rows (safety mode, timeout behavior, semi-auto timeout) are plain `updateSettings`.
- `initializeState` posts `autonomyLevelChanged` as a side effect.
- Webview → host routing: `_receivePanelMessage` checks `state.webview === sender`, then `bindIncomingMessage(message, panelId)` stamps the host-known panel id. This is the single place a message acquires its panel identity.
- Precedent for a secondary editor tab: `openVisualTestDashboard(config, originPanelId)` (singleton, `ViewColumn.Beside`, `_vtDashboardChatOrigin`).

## Design

### What the user sees

- **⋯ menu:** every item shows icon + text: Open in new tab, Export conversation, Active Mode, Personas & skills, Badges, About, Connections, Settings.
- **Settings / Personas & skills / Badges / About** open the Mysti tab beside the chat, on that section. If the tab is open, it is revealed and switches section; there is never a second one. Nothing opens inline in the chat.
- **The tab:** left nav (Settings · Personas & skills · Connections · Badges · About); one section at a time on the right at full height with its own scroll; a header line "Configuring: \<chat title\>".
- **Rebinding:** opening the tab from another chat's ⋯ menu binds it to that chat; the header updates.
- **Connections** in the nav opens the existing Connections tab (`mysti.openConnections`); it is not rebuilt inside the hub.
- **Bound chat closed:** the header reads "No chat selected"; Settings and Personas & skills turn read-only (there is no chat to apply an edit to, and applying it to some other chat would be a surprise); Badges and About stay readable and their links work. Opening the tab from any chat rebinds it.
- **Bound chat switches conversation** (new, switch, delete, fork, import): the tab refreshes to the chat's current conversation — its title and its personas & skills.
- **Unchanged:** the composer controls, the ⌘K palette entries (they click the same buttons, which now open the tab), the Active Mode strip, the Runs/Changes docks.

### Host (`src/chat/settingsHub.ts` + `ChatViewProvider`)

**`src/chat/settingsHub.ts`** — pure, no `vscode` import:

```ts
export type HubSection = 'settings' | 'agents' | 'badges' | 'about';
/** Webview → host types the hub may send; each is re-bound to the origin chat. */
export const HUB_INBOUND_TYPES: ReadonlySet<string>;   // the 10 types listed in Current state
/** The subset that needs no chat; still honoured after the origin closes. */
export const HUB_UNBOUND_TYPES: ReadonlySet<string>;   // openExternal, openConnections
/** Host → origin-chat types that are also copied to the hub. */
export const HUB_MIRROR_TYPES: ReadonlySet<string>;    // see below
export function isHubSection(v: unknown): v is HubSection;
```

`HUB_MIRROR_TYPES` = `modelsUpdated`, `providerAvailability`, `manifestUpdated`, `agentConfigUpdated`, `agentsUpdated`, `badgesUpdate`, `badgeShareCopied`, `settingsError`, `providerSwitched`, `agentChanged`, `modelChanged`. (`settingsSync` is not mirrored; it is posted directly to one side, below.)

A type joins `HUB_INBOUND_TYPES` only if a control inside one of the four panels sends it. Everything else from the hub — `sendMessage`, `permissionResponse`, `cancelRequest`, `newConversation`, `autonomyLevelChanged`, `uiReady`, … — is **dropped**, so a hidden card or boot side effect in the hub can never act on the chat's behalf.

**`ChatViewProvider`:**

- `private _hub: { panel: vscode.WebviewPanel; originPanelId: string | null } | null`.
- `public openSettingsHub(section: HubSection, originPanelId: string)`:
  - If `_hub` exists: set `originPanelId`, `reveal()`, and if the origin changed, re-send initial state (below). Otherwise `createWebviewPanel('mysti.settingsHub', 'Mysti', ViewColumn.Beside, { enableScripts, localResourceRoots, retainContextWhenHidden })`, html = `getWebviewContent(webview, extensionUri, version, { view: 'hub' })`, icon = Mysti logo.
  - Post `{ type: 'hubShow', payload: { section, chatTitle } }` (`chatTitle` from the origin's current conversation, or `null`; `section: null` keeps the section currently shown).
  - `onDidDispose` → `_hub = null`.
- **The hub is not registered in `_panelStates`.** It gets its own `onDidReceiveMessage` that checks `sender === _hub.panel.webview`, drops the message if the origin is null or no longer in `_panelStates` (except `HUB_UNBOUND_TYPES`, which need no chat) or its type is not in `HUB_INBOUND_TYPES`, then calls `bindIncomingMessage(message, _hub.originPanelId)` and `_handleMessage`. Loops over `_panelStates` (broadcast, dispose, cancel) therefore never see it as a chat.
- **Initial state:** `_sendInitialState(panelId, forHub = false)`. With `forHub` it builds the payload for `panelId`, strips the conversation, posts only to the hub, and skips the panel's side effects (context restore, wizard, demotion notice, and everything after the `initialState` post).
- **Mirroring:** `_mirrorToHub(panelId, message)` posts to the hub when `_hub?.originPanelId === panelId` and `message.type ∈ HUB_MIRROR_TYPES`. Called from `_postToPanel` and from `_broadcastToAll` (with the matching types).
- **Settings sync:** after an `updateSettings` for the bound chat is handled, post `{ type: 'settingsSync', payload }` directly to whichever side did **not** send it — the origin chat when the hub sent it (`_receiveHubMessage`), the hub when the chat sent it (`_receivePanelMessage`).
- **Conversation follow:** `_receivePanelMessage` notes the origin's `currentConversationId` before handling a message; if it changed, the hub gets a fresh initial state and `hubShow { section: null }` (new title).
- **Origin disposed:** in each chat panel's dispose path, if `_hub?.originPanelId === panelId`, set it to `null` and post `hubShow { section: null, chatTitle: null }`.
- New chat → host message `openSettingsHub { section }`, handled as `openSettingsHub(section, msg.panelId)` after `isHubSection` validation.

### Webview (`media/chat/`, no new files)

- `getWebviewContent(..., opts?: { view?: 'hub' })` adds `class="view-hub"` to `<body>`; default output is byte-identical to today.
- **`chat.css`:** under `.view-hub`, hide the header, `#workarea`, composer, suggestions, docks, Active Mode strip, loading overlay; show a new nav + "Configuring:" header; the visible panel fills the height (no `max-height`). New ⋯ menu row styles (icon + label).
- **`index.html`:** a `<span class="overflow-label">` in each ⋯ button (ids unchanged); the hub nav + header markup (hidden unless `.view-hub`).
- **`chat.js`:**
  - `var IS_HUB = document.body.classList.contains('view-hub')`.
  - Chat view: the four buttons post `openSettingsHub { section }` instead of toggling.
  - Hub view: nav clicks and `hubShow` show exactly one of the four panels; header shows the title or "No chat selected"; Settings and Personas & skills are read-only when unbound.
  - `settingsSync`: merge into `state.settings` (and the dotted keys into `agentSettings` / `permissionSettings` / `brainstorm*` / `providerSettings`), then refresh the controls. The settings-to-controls block of `initializeState` (thinking/provider/model/custom-model/provider sections/`syncInlineSelectors`/brainstorm/permission rows) is extracted into `applySettingsToControls()` and called from both; `initializeState` behavior is unchanged.

## Testing

Run `npm test` and `npm run typecheck` before and after.

- `tests/chat/settingsHub.test.ts` — the allowlists are exactly the listed sets; `isHubSection` rejects unknown values.
- `ChatViewProvider` hub test (mock vscode):
  - opening twice creates one panel; opening from chat B rebinds and re-sends state;
  - a hub `updateSettings` reaches `_handleUpdateSettings` with the **origin** panel id and posts `settingsSync` to the origin; a chat `updateSettings` posts `settingsSync` to the hub;
  - hub `sendMessage`, `permissionResponse`, `cancelRequest`, `autonomyLevelChanged` are dropped;
  - a message from a webview that is not the hub's is dropped;
  - `_broadcastToAll` of a non-mirror type does not reach the hub; a mirror type does;
  - disposing the origin unbinds; with no origin, `updateSettings` is dropped and `openExternal` is not.
- `tests/webview/settingsHubBrowser.test.ts` (Chromium, pattern of `agentMenuLayoutBrowser.test.ts`):
  - hub view shows the nav and exactly one section; `hubShow` switches it;
  - in chat view, clicking `#settings-btn` posts `openSettingsHub` and no panel un-hides;
  - `settingsSync` updates `state.settings` and the selects;
  - every ⋯ button has a visible, non-empty label.
- Manual (F5): open Settings from the sidebar, change the model in the tab, send a message from the sidebar chat, confirm the response is attributed to the new model.

## Out of scope

- Global settings changed in one chat still do not propagate to *other* open chats' `state.settings` (pre-existing).
- Folding Connections into the hub, moving the Active Mode strip, removing the panels' hidden markup from the chat view (other code still reads those selects).

## Risks

- **`chat.js` boots in a view it was not written for.** Contained by: the inbound allowlist (boot side effects like `autonomyLevelChanged`/`uiReady` are dropped), the stripped conversation in the hub's initial state, and the hub not being in `_panelStates`.
- **Allowlist drift:** a new control added to a panel that sends a new type silently does nothing in the hub. The settingsHub test pins the list; the browser test exercises one control per section.
