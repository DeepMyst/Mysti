# 25 — Mysti as the default agent + recoverable auth failures

**Goal:** Mysti is the agent a user lands on and keeps, and every credential failure ends in a **button**, not a sentence. Replace the dead-end `Error: DeepMyst rejected the request — try signing in again (run "DeepMyst: Sign In").` with a card offering **Sign in / Create account / Switch agent / Retry**, where "Switch agent" lists only the agents that are actually installed.

**Status:** **PHASES 0–4 SHIPPED (2026-09-03)** — `tsc --noEmit` clean, provider-literal guard passes, 3 new test files (47 tests) plus one updated. Written after auditing the tree — every claim below carries a `file:line`.

**Shipped surface:** `AgentSelection`/`PseudoAgentType` (types.ts), `PSEUDO_AGENT_IDS`/`isPseudoAgentId`/`DEFAULT_AGENT` (constants.ts), the `mysti.defaultAgent` setting (default `mysti`), `_getPanelAgent()` + a reworked `_getPanelProvider()` + `_explicitSetting()` (ChatViewProvider), `classifyCoordinatorFailure()` + `credentialState()` (CoordinatorModelClient), `_postMystiFailure()` / `_mystiFailureActions()` / `_switchableAgents()` / `_handleSwitchAgentAndRetry()` / `_openDeepMystWeb()`, the `mystiActionRequired` message, `renderMystiActionCard()` in the webview (with `handleMystiSignInRequired` reduced to a caller of it), and the Mysti-first agent menu.

**Deviations from the plan as written, and why:**
- Phase 0 was going to default `mysti.defaultAgent` to `claude-code` and flip it in Phase 1. Both landed together, so it ships at `mysti` directly.
- The one-time `globalState` migration flag was dropped as unnecessary: `_getPanelAgent` reads `config.inspect()` and treats an explicitly-set legacy `defaultProvider` as the choice it is. Nothing is written on anyone's behalf, and the rule stays reversible.
- `ProviderManager._getDefaultProviderId()` also had to learn about `defaultAgent` (it feeds prompt enhancement, which takes no explicit provider id) — otherwise picking Cursor in the menu would still enhance on `defaultProvider`. It resolves through the registry, so a pseudo-agent can never leak out of it.
- An explicit `spent` flag guards the card in addition to `disabled`, because a duplicate click is a duplicate *spend* rather than only a UI glitch.
- Welcome copy was left alone (Phase 1.6). The honest-limit message is carried by the card's "No other agent is installed yet" note instead of marketing text nobody reads.

---

## What is actually true today (audited 2026-09-02)

### 1. `mysti` is a pseudo-agent that cannot be persisted

`MYSTI_PROVIDER_ID = 'mysti'` exists ([MystiOrchestratorManager.ts:56](src/managers/MystiOrchestratorManager.ts#L56)) but **nothing registers it**: `ProviderRegistry._registerBuiltInProviders()` registers 15 CLI providers and no coordinator, and `ProviderType` ([types.ts:27](src/types.ts#L27)) does not contain `'mysti'`. It is routed purely off the webview-supplied `settings.provider` string at [ChatViewProvider.ts:3426](src/providers/ChatViewProvider.ts#L3426).

Four consequences, all confirmed in code:

| # | Fact | Where |
|---|------|-------|
| A | `_getPanelProvider()` validates against the registry, so it can **never return `'mysti'`** — it logs a warning and returns `DEFAULT_PROVIDER`. | [ChatViewProvider.ts:783-793](src/providers/ChatViewProvider.ts#L783-L793) |
| B | Therefore `_canvasSteeringReachable()`'s `=== 'mysti'` branch is **unreachable dead code** — canvas steering notes are reported as unreachable even on a Mysti panel. | [ChatViewProvider.ts:10906](src/providers/ChatViewProvider.ts#L10906) |
| C | `_sendInitialState` re-resolves the provider through `_getPanelProvider`, then **auto-switches to `firstInstalled`** whenever the id has no `wizardStatus.providers` entry. `'mysti'` never has one. | [ChatViewProvider.ts:914](src/providers/ChatViewProvider.ts#L914), [:943-952](src/providers/ChatViewProvider.ts#L943-L952) |
| D | Selecting Mysti in the agent menu writes a **per-panel in-memory override only** — `updateSettings` writes global `defaultProvider` only when `panelId` is absent, and the webview always sends one (`postMessageWithPanelId`). | [ChatViewProvider.ts:5150-5163](src/providers/ChatViewProvider.ts#L5150-L5163), [chat.js:3910](media/chat/chat.js#L3910) |

**So Mysti today cannot survive a panel reload even when the user picks it.** That has to be fixed before "make it the default" means anything.

### 2. `DEFAULT_PROVIDER` must stay a real CLI id

`DEFAULT_PROVIDER = 'claude-code'` ([constants.ts:23](src/constants.ts#L23)) is the registry rescue in `ProviderManager._getActiveProvider()`: an unknown id falls back to it, and if *that* lookup misses it **throws** `Provider not found` ([ProviderManager.ts:157-171](src/managers/ProviderManager.ts#L157-L171)). Flipping the constant to `'mysti'` turns every stale-provider fallback into a thrown error. It is read at 23 sites and `_getPanelProvider` has 19 callers, all of which want a spawnable backend.

### 3. The good auth UX already exists — for one case only

- **Pre-flight (not signed in at all):** `_runMystiAgentic` checks `status().ready` and posts `mystiSignInRequired` ([ChatViewProvider.ts:8408-8418](src/providers/ChatViewProvider.ts#L8408-L8418)); the webview renders a card with a real **"Sign in to DeepMyst"** button ([chat.js:7517-7534](media/chat/chat.js#L7517-L7534), styled at [chat.css:8605](media/chat/chat.css#L8605)).
- **Mid-stream (the reported bug):** the 401/403 goes through `_friendlyMystiError` ([ChatViewProvider.ts:9666-9673](src/providers/ChatViewProvider.ts#L9666-L9673)) → posted as `{type:'error'}` → `showError()` renders **plain red text with no buttons** ([chat.js:10761-10767](media/chat/chat.js#L10761-L10767)).

The fix is therefore not "write a nicer string" — it is **route recoverable coordinator failures to a card instead of `showError`**.

### 4. The advice in that string can be wrong

`status().ready` is true if **either** an OpenRouter key is configured **or** DeepMyst is signed in ([CoordinatorModelClient.ts:135-138](src/services/CoordinatorModelClient.ts#L135-L138)). A 401 on the OpenRouter path is told "sign in to DeepMyst again", which fixes nothing. `_isRetryable` already hard-stops 401/402/403 ([CoordinatorModelClient.ts:405-410](src/services/CoordinatorModelClient.ts#L405-L410)) — the classification exists, it just isn't carried to the UI.

### 5. Reusable parts already in the tree

`mysti.deepmyst.signIn` / `signOut` commands ([extension.ts:547-548](src/extension.ts#L547-L548)); the `signInDeepMyst` webview message ([ChatViewProvider.ts:1253](src/providers/ChatViewProvider.ts#L1253)); `DeepMystAuthManager.signIn()`'s Clerk connect flow ([DeepMystAuthManager.ts:232-292](src/managers/DeepMystAuthManager.ts#L232-L292)); the buttoned `showAuthError` card pattern ([chat.js:10769-10797](media/chat/chat.js#L10769-L10797)); `providerAvailability` (installed/not, + `installCommand`) already in webview state ([ChatViewProvider.ts:1122-1133](src/providers/ChatViewProvider.ts#L1122-L1133)).

### 6. Two things break specifically *because* Mysti becomes the default

- **The wizard blocks the chat** when `!wizardStatus.anyReady` ([ChatViewProvider.ts:918-936](src/providers/ChatViewProvider.ts#L918-L936)). `anyReady` counts CLI providers only — a user whose only working agent is Mysti gets an "install a CLI" wall instead of a chat.
- **`_availableMystiBackends()` falls back to the FULL list when nothing is installed** ([ChatViewProvider.ts:9725-9736](src/providers/ChatViewProvider.ts#L9725-L9736)). Default-Mysti on a bare machine would tell the coordinator to delegate to 14 agents that don't exist.

---

## Design decisions

**D1 — Separate "selected agent" from "backend provider". Do not register `mysti` in the registry.**
New setting `mysti.defaultAgent` (`ProviderType | 'mysti' | 'brainstorm'`, default `mysti` in Phase 1) plus `_getPanelAgent(panelId)`. `mysti.defaultProvider` / `DEFAULT_PROVIDER` keep their exact current meaning — the CLI backend for delegation, brainstorm, `@agent` routing, compaction, prompt-enhance and every one of the 19 `_getPanelProvider` call sites. *Rejected alternative:* adding `'mysti'` to `ProviderType` + the registry — it would touch both TS-enforced maps in `ProviderManifest.ts`, both in `BrainstormManager.ts`, the model registry, install/auth/wizard flows and the provider-literal guard, all for an agent with no CLI, no install command and no model list.

**D2 — One action card, several shapes, chosen by a classified reason.**

| reason | trigger | buttons |
|---|---|---|
| `signin` | no credential at all (today's pre-flight) | **Sign in** · **Create account** · Switch agent |
| `auth-rejected` | 401/403 with a `dm_` key present | **Sign in again** · Create account · **Switch agent** · Retry |
| `openrouter-rejected` | 401/403 while `_useOpenRouter()` | **Open OpenRouter settings** · Switch agent |
| `credits` | 402 / out-of-credits | **Top up** · Switch agent · Retry |

"Switch agent" is on every shape — it is the one action that always works.

**D3 — The switch list shows *installed* agents (`providerAvailability[id].available`), not *authenticated* ones.** An installed-but-unauthenticated backend still has a working recovery path (the existing `authError` card with "Open Terminal & Authenticate"); filtering on auth could present an empty list, which is the failure we are removing. Brainstorm appears only at ≥2 installed, matching [chat.js:4185-4213](media/chat/chat.js#L4185-L4213).

**D4 — Sign-up vs sign-in.** `${webUrl}/connect/vscode?redirect_uri=…&state=…` is a Clerk page that already handles both. Two visually distinct buttons need the web app to honour an `intent=signup` param — **confirm against v2.deepmyst.com before building it.** If it can't distinguish, ship one **"Sign in / Create account"** button plus a plain "New to DeepMyst?" link; do not ship two buttons that do the identical thing.

---

## Phases

| # | Ships |
|---|-------|
| 0 | Agent selection becomes persistable and Mysti-aware. No default change yet. |
| 1 | Mysti becomes the default agent. |
| 2 | The action card (the actual ask). |
| 3 | Correct advice per credential path + stale-key hygiene. |
| 4 | Tests, guards, migration. |

### Phase 0 — make the selection real (no behaviour change for existing users)

1. `types.ts`: `export type AgentSelection = ProviderType | 'mysti' | 'brainstorm';` and use it for the webview-facing selection. `ProviderType` is untouched.
2. `package.json`: `mysti.defaultAgent` — enum = the 15 provider ids + `mysti` + `brainstorm`, `enumDescriptions` to match, **default `claude-code` in this phase**, `scope: application` is wrong here (it is a per-user preference, not authority) → leave default `window` scope. It is *not* an authority setting, so it stays out of `settingsClamp`.
3. `ChatViewProvider._getPanelAgent(panelId)`: panel override → `mysti.defaultAgent` → validate against `registry ∪ {mysti, brainstorm}` → fall back to `_getPanelProvider(panelId)`. **Invariant to keep and test: `_getPanelProvider` never returns a pseudo-agent; `_getPanelAgent` may.**
4. `updateSettings` ([:5150](src/providers/ChatViewProvider.ts#L5150)): when `settings.provider` is a pseudo-agent, keep the per-panel override *and* write `mysti.defaultAgent` globally so the choice survives a reload. Trade-off, stated explicitly: per-panel isolation stays for the live value; the global write only moves the *default* for newly opened panels. (Today a real provider chosen in a panel is likewise not persisted — this plan does not change that for real providers, only for the agent selection.)
5. `_sendInitialState`: `settings.provider` comes from `_getPanelAgent`; the "auto-select first installed" rescue at [:943-952](src/providers/ChatViewProvider.ts#L943-L952) applies **only** when the resolved agent is a real provider.
6. Fix `_canvasSteeringReachable()` to consult `_getPanelAgent` (bug B above).

### Phase 1 — Mysti is the default

1. `mysti.defaultAgent` default → `"mysti"`. `DEFAULT_PROVIDER` unchanged.
2. **Migration:** only adopt the new default for users who never chose — `config.inspect('defaultProvider')?.globalValue === undefined`. Anyone with an explicit provider keeps it. One-time flag in `globalState`.
3. **Wizard no longer blocks a Mysti-capable user.** Extend the [:918-936](src/providers/ChatViewProvider.ts#L918-L936) gate to `wizardStatus.anyReady || mystiCoordinator.status().ready`. When *nothing* is ready, the wizard still shows — with **"Continue with Mysti — sign in to DeepMyst"** as the primary card above the CLI install grid.
4. `_availableMystiBackends()`: when the availability cache is warm and nothing is installed, return `[]` and tell the coordinator it has **no delegation backends** (answer directly / suggest installing one) instead of advertising 14 phantom agents. Keep the cold-cache full-list fallback — distinguish "cache cold" from "nothing installed" via `CachedWizardStatusResult.complete`.
5. Agent menu: move the Mysti item to the top of `#agent-menu` with the `Active` badge and keep the divider below it ([index.html:743-822](media/chat/index.html#L743-L822), inside the existing provider-literals allowlist markers).
6. **State the honest limit in the welcome copy:** with no CLI installed and `mysti.mysti.localExecution` off (its default), Mysti reads and reasons but does not edit files. The card in Phase 2 offers "Install an agent" for exactly this.

### Phase 2 — the action card (replaces the dead-end string)

1. **Classifier (pure, no `vscode`):** `classifyCoordinatorFailure(raw, { hasDeepMystKey, usingOpenRouter })` → `'signin' | 'auth-rejected' | 'openrouter-rejected' | 'credits' | 'other'`, living beside the existing hard-stop regex in `CoordinatorModelClient.ts` and unit-tested there.
2. **New extension→webview message `mystiActionRequired`**: `{ reason, message, actions: ActionId[], agents: {id, name, iconPath}[], retryable: boolean }`. Agents come from `_buildProviderAvailability` filtered to `available`, with display names from the manifest (never provider-name literals in the webview — [check-provider-literals.js](scripts/check-provider-literals.js) enforces this).
3. **Rewire `_friendlyMystiError`'s callers** ([:8735](src/providers/ChatViewProvider.ts#L8735)): recoverable reasons post `mystiActionRequired`; everything else keeps `{type:'error'}`. Background jobs get the same actions on the job card (`jobError` payload gains `actions`) so a bg failure is equally recoverable.
4. **One webview renderer, `renderActionCard(payload)`** — and `handleMystiSignInRequired` becomes a thin caller of it, so there is exactly one card implementation, not two. CSP-safe (`addEventListener`, never inline `onclick`), everything through `escapeHtml`.
5. **"Switch agent"** expands an inline list of the `agents[]` from the payload. Selecting one runs the same path as an agent-menu click (`state.settings.provider = id` → `updateModelsForProvider` → `updateSettings`) and then, if the card was `retryable`, re-sends the last user message on the new agent. New webview→extension messages: `switchAgentAndRetry {agentId, retryContent?}` and `openDeepMystSignup`.
6. Card CSS extends the existing `.mysti-signin-btn` block ([chat.css:8605](media/chat/chat.css#L8605)) — secondary/ghost button variants, no new design language.

### Phase 3 — correct advice, and don't keep a dead key

1. `openrouter-rejected` says *"Your OpenRouter key was rejected"* and opens the setting — never "sign in to DeepMyst".
2. **"Sign in again" on `auth-rejected` runs `signOut()` then `signIn()`**, so a rejected `dm_` key does not linger in SecretStorage when the re-auth is cancelled. Today `signIn()` only overwrites on success, so a cancelled re-auth leaves the stale key and the next turn fails identically.
3. One retry per card; the button disables after use so a hard 401 cannot be click-looped into a spend loop.

### Phase 4 — tests, guards, migration

- `tests/services/coordinatorFailureClassifier.test.ts` — pure classifier, incl. the OpenRouter-vs-DeepMyst split and the 402/401 boundary.
- `tests/integration/mystiDefaultAgent.test.ts` — default resolution; **survives a reload**; `_getPanelProvider` never returns a pseudo-agent; wizard does not block when the coordinator is ready; `_availableMystiBackends()` returns `[]` on a warm-empty cache and the full list on a cold one; migration leaves an explicit `defaultProvider` alone.
- `tests/webview/mystiActionCard.test.ts` — buttons per reason; switch list contains only available agents (and no brainstorm below 2); HTML escaping of `message`.
- Regression sweep: `tests/integration/chatViewDebranding.test.ts`, `tests/webview/providerLiteralsGuard.test.ts`, `tests/webview/enhanceAffordance.test.ts` (pseudo-agent path), `tests/integration/chatViewWizardRouting.test.ts`.
- Gates: `npx tsc --noEmit`, `npm test`, `npm run lint` (the provider-literal guard trips on any new quoted provider id outside the allowlisted bootstrap regions — note `'mysti'` itself is *not* in `PROVIDER_IDS`, so the card's own id is safe).

---

## Risks

- **R1 — Mysti leaking into the CLI path.** Any code that reads the *agent* where it needs a *backend* gets `Provider not found`. Mitigated by D1 plus the explicit `_getPanelProvider` invariant test.
- **R2 — Auxiliary paths under a Mysti panel.** Compaction ([:4595](src/providers/ChatViewProvider.ts#L4595)), prompt-enhance, `@agent:role`, brainstorm all resolve through `_getPanelProvider`, which keeps yielding the CLI backend — correct by construction, but each needs one smoke check. The webview's `resolveEnhanceProvider` already returns `null` for pseudo-agents ([chat.js:4102-4106](media/chat/chat.js#L4102-L4106)) and leaves the button enabled; confirm the extension side falls back cleanly.
- **R3 — First-run capability gap.** Default Mysti + no CLI + `localExecution` off = a chat that reads but does not edit. Handled by honest welcome copy (Phase 1.6) and the card's "Install an agent" action, not by silently flipping `localExecution` (that is a machine-scoped authority setting and stays off).
- **R4 — Anything funnel/telemetry-keyed on `defaultProvider`** now sees a value that no longer means "the agent the user talks to". Audit `TelemetryManager` + `team.json` generation ([:3572](src/providers/ChatViewProvider.ts#L3572)) before Phase 1.
- **R5 — Unverified external dependency:** the `intent=signup` param in D4. Do not build two buttons until v2.deepmyst.com is confirmed.

## Out of scope

Registering `mysti` in the provider registry; changing `DEFAULT_PROVIDER`; touching `settingsClamp` / authority settings; any change to how the `dm_` key is stored or scoped.
