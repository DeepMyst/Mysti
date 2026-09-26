# Onboarding (Plan 32) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Plan 32 onboarding: a three-step first-run wizard built on the existing setup wizard, a Getting-started card, five once-only hints, a searchable `/help` card, `/mode plan|ask|auto|full`, and a rewritten VS Code walkthrough.

**Architecture:** Host state lives in one pure module, `src/chat/onboarding.ts` (tips seen, Getting-started visibility, mention flag), wired into `ChatViewProvider` through `initialState.onboarding` and five small webview messages. Everything visual is in the existing chat webview (`media/chat/index.html`/`chat.js`/`chat.css`); the wizard keeps its provider cards and their install/auth logic and only MOVES them between sections. The walkthrough is package.json + six SVGs.

**Tech Stack:** TypeScript (host), ES5-style browser JS (webview, no build step), Vitest + Playwright Chromium browser suites, VS Code walkthrough contribution.

**Spec:** `plans/32-onboarding.md` (decisions D1–D9) + the design canvas linked there.

## Global Constraints

- Work in the worktree `../Mysti-onboarding` on branch `feat/plan-32-onboarding` (a second session is implementing Plan 31 in the main checkout, touching the same webview files).
- `script-src` is nonce-only: NO inline `on*=` attributes in index.html or in HTML strings chat.js builds; bind with `addEventListener` (`tests/webview/inlineHandlerCsp.test.ts`).
- No quoted provider id (`'claude-code'`, `'cline'`, `'continue'`…) in chat.js/index.html outside `mysti:provider-literals:allow-*` markers (`npm run lint` → `scripts/check-provider-literals.js`). Card metadata goes in `data-*` attributes inside the existing allow block.
- Every `*Browser.test.ts` must import `CHROMIUM_UNAVAILABLE` from `./chromiumAvailability`, contain `chromium.launch(`, `if (CHROMIUM_UNAVAILABLE) { return; }`, and declare tests with `it.skipIf(CHROMIUM_UNAVAILABLE)` (`tests/webview/browserSuitesSkipHonestly.test.ts`).
- The DeepMyst fast path (`wizard-fastpath`) must stay before `class="wizard-providers"` in index.html and its block must still say "nothing to install" and "no API key" (`tests/webview/wizardZeroInstallPath.test.ts`).
- All new source files carry the Apache-2.0 header. `[Mysti]` log prefix. Private members `_`-prefixed.
- Copy is sentence case, plain words, no emoji. Mode names are exactly Plan, Ask, Auto, Full.
- Run `npm run typecheck` and `npx vitest run` before and after; full gate (`npm run lint`, `npm test`, `npm run compile`) in Task 11.

## Review Focus

1. A user who clicks "Skip for now" must never see the wizard again on panel load (dismissal still persists), while `Mysti: Get Started` still opens it — pinned in Task 2 (`showOnboarding` ignores `setupWizardDismissed`).
2. A tip must never appear twice: marked seen on SHOW (not on dismiss), and a second trigger in the same session shows nothing — pinned in Task 8.
3. `/mode full` from the composer must set BOTH `mode` and `accessLevel` (a mode-only write would leave the pill saying Ask while the gate is on Full, or vice versa) — pinned in Task 3.
4. The wizard's Continue must stay disabled until an agent is actually ready, including after DeepMyst sign-in completes in the browser (`mystiReadyChanged`) — pinned in Task 5.
5. An invalid `tipSeen` id from the webview must not grow `mysti.tips.seen` unboundedly (only the five known ids are stored) — pinned in Tasks 1 and 2.

---

### Task 1: Host onboarding state — `src/chat/onboarding.ts`

**Files:**
- Create: `src/chat/onboarding.ts`
- Test: `tests/chat/onboarding.test.ts`

**Interfaces:**
- Produces: `TIP_IDS`, `TipId`, `isTipId(v)`, `WIZARD_STEPS`, `WizardStep`, `isWizardStep(v)`, `hasChosenMode(config)`, `seenTips(store)`, `markTipSeen(store, id)`, `hideGettingStarted(store)`, `recordAgentMention(store)`, `onboardingSnapshot(inputs): Promise<OnboardingSnapshot>`, keys `TIPS_SEEN_KEY='mysti.tips.seen'`, `GETTING_STARTED_KEY='mysti.gettingStarted'`, `USED_MENTION_KEY='mysti.onboarding.usedMention'`.
- `OnboardingSnapshot = { tips: { enabled: boolean; seen: TipId[] }; gettingStarted: { items: { connect; mode; task; mention: boolean } } | null }`

- [ ] **Step 1: Write the failing test** — `tests/chat/onboarding.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  TIP_IDS, isTipId, isWizardStep, hasChosenMode, seenTips, markTipSeen,
  hideGettingStarted, recordAgentMention, onboardingSnapshot,
  TIPS_SEEN_KEY, GETTING_STARTED_KEY,
} from '../../src/chat/onboarding';

function store(initial: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    map: m,
    get<T>(k: string, d?: T): T { return (m.has(k) ? m.get(k) : d) as T; },
    async update(k: string, v: unknown) { m.set(k, v); },
  } as any;
}
const base = { tipsEnabled: true, hasCompletedSetup: false, agentReady: false, modeChosen: false, messagesSent: 0 };

describe('tip ids', () => {
  it('accepts only the five known tips', () => {
    expect(TIP_IDS).toEqual(['permission', 'mention', 'rewind', 'brainstorm', 'compaction']);
    expect(isTipId('rewind')).toBe(true);
    expect(isTipId('__proto__')).toBe(false);
    expect(isTipId(3)).toBe(false);
  });
  it('knows the three wizard steps', () => {
    expect(isWizardStep('mode')).toBe(true);
    expect(isWizardStep('finish')).toBe(false);
  });
});

describe('seen tips', () => {
  it('stores each tip once and drops junk already on disk', async () => {
    const s = store({ [TIPS_SEEN_KEY]: ['mention', 'bogus', 7] });
    expect(seenTips(s)).toEqual(['mention']);
    await markTipSeen(s, 'rewind');
    await markTipSeen(s, 'rewind');
    expect(s.map.get(TIPS_SEEN_KEY)).toEqual(['mention', 'rewind']);
  });
  it('treats a non-array value as nothing seen', () => {
    expect(seenTips(store({ [TIPS_SEEN_KEY]: 'rewind' }))).toEqual([]);
  });
});

describe('getting started', () => {
  it('shows for a brand-new user and remembers that decision', async () => {
    const s = store();
    const snap = await onboardingSnapshot({ store: s, ...base });
    expect(snap.gettingStarted).toEqual({ items: { connect: false, mode: false, task: false, mention: false } });
    expect(s.map.get(GETTING_STARTED_KEY)).toBe('show');
  });
  it('never shows for someone who used Mysti before it existed', async () => {
    const s = store();
    const snap = await onboardingSnapshot({ store: s, ...base, hasCompletedSetup: true });
    expect(snap.gettingStarted).toBeNull();
    expect(s.map.get(GETTING_STARTED_KEY)).toBe('hidden');
  });
  it('keeps showing after the first answer if it was decided before it', async () => {
    const s = store({ [GETTING_STARTED_KEY]: 'show' });
    const snap = await onboardingSnapshot({ store: s, ...base, hasCompletedSetup: true, messagesSent: 1 });
    expect(snap.gettingStarted?.items.task).toBe(true);
  });
  it('stops rendering once hidden or once every item is done', async () => {
    const s = store();
    await hideGettingStarted(s);
    expect((await onboardingSnapshot({ store: s, ...base })).gettingStarted).toBeNull();
    const t = store({ [GETTING_STARTED_KEY]: 'show' });
    await recordAgentMention(t);
    const done = await onboardingSnapshot({ store: t, ...base, agentReady: true, modeChosen: true, messagesSent: 3 });
    expect(done.gettingStarted).toBeNull();
  });
  it('reports tips enabled and seen', async () => {
    const snap = await onboardingSnapshot({ store: store({ [TIPS_SEEN_KEY]: ['permission'] }), ...base, tipsEnabled: false });
    expect(snap.tips).toEqual({ enabled: false, seen: ['permission'] });
  });
  it('treats a non-number message count as zero', async () => {
    const snap = await onboardingSnapshot({ store: store(), ...base, messagesSent: undefined as unknown as number });
    expect(snap.gettingStarted?.items.task).toBe(false);
  });
});

describe('hasChosenMode', () => {
  it('is true only when the user set mode or access themselves', () => {
    const cfg = (g: Record<string, unknown>) => ({ inspect: (k: string) => (k in g ? { globalValue: g[k] } : undefined) });
    expect(hasChosenMode(cfg({}))).toBe(false);
    expect(hasChosenMode(cfg({ accessLevel: 'ask-permission' }))).toBe(true);
    expect(hasChosenMode(cfg({ defaultMode: 'quick-plan' }))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '../../src/chat/onboarding'`)

Run: `npx vitest run tests/chat/onboarding.test.ts`

- [ ] **Step 3: Implement** — `src/chat/onboarding.ts`

```ts
/**
 * (Apache-2.0 header as in src/chat/incomingMessage.ts)
 *
 * Plan 32 — the onboarding state the host owns: which first-time tips this
 * user has already seen, whether the Getting-started card still renders, and
 * whether they have ever sent a message to another agent with @. Pure over a
 * Memento so it tests without a VS Code host.
 */
import type * as vscode from 'vscode';

export const TIP_IDS = ['permission', 'mention', 'rewind', 'brainstorm', 'compaction'] as const;
export type TipId = (typeof TIP_IDS)[number];
export function isTipId(value: unknown): value is TipId {
  return typeof value === 'string' && (TIP_IDS as readonly string[]).includes(value);
}

export const WIZARD_STEPS = ['connect', 'mode', 'task'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export function isWizardStep(value: unknown): value is WizardStep {
  return typeof value === 'string' && (WIZARD_STEPS as readonly string[]).includes(value);
}

export const TIPS_SEEN_KEY = 'mysti.tips.seen';
export const GETTING_STARTED_KEY = 'mysti.gettingStarted';
export const USED_MENTION_KEY = 'mysti.onboarding.usedMention';

type Store = Pick<vscode.Memento, 'get' | 'update'>;

export interface GettingStartedItems { connect: boolean; mode: boolean; task: boolean; mention: boolean }
export interface OnboardingSnapshot {
  tips: { enabled: boolean; seen: TipId[] };
  /** null = do not render the card. */
  gettingStarted: { items: GettingStartedItems } | null;
}
export interface OnboardingInputs {
  store: Store;
  tipsEnabled: boolean;
  /** `mysti.hasCompletedSetup`: true for anyone who got an answer before this shipped. */
  hasCompletedSetup: boolean;
  agentReady: boolean;
  modeChosen: boolean;
  messagesSent: number;
}

/** True once the user has set mode or access themselves (the pill and the wizard both write these). */
export function hasChosenMode(config: { inspect(key: string): { globalValue?: unknown } | undefined }): boolean {
  return ['defaultMode', 'accessLevel'].some((k) => config.inspect(k)?.globalValue !== undefined);
}

export function seenTips(store: Store): TipId[] {
  const raw = store.get<unknown>(TIPS_SEEN_KEY, []);
  return Array.isArray(raw) ? raw.filter(isTipId) : [];
}

export async function markTipSeen(store: Store, id: TipId): Promise<void> {
  const seen = seenTips(store);
  if (!seen.includes(id)) { await store.update(TIPS_SEEN_KEY, [...seen, id]); }
}

export async function hideGettingStarted(store: Store): Promise<void> {
  await store.update(GETTING_STARTED_KEY, 'hidden');
}

export async function recordAgentMention(store: Store): Promise<void> {
  if (store.get<boolean>(USED_MENTION_KEY) !== true) { await store.update(USED_MENTION_KEY, true); }
}

export async function onboardingSnapshot(i: OnboardingInputs): Promise<OnboardingSnapshot> {
  let visibility = i.store.get<string>(GETTING_STARTED_KEY);
  if (visibility !== 'show' && visibility !== 'hidden') {
    // Decided once, on the first panel load after install or upgrade.
    visibility = i.hasCompletedSetup ? 'hidden' : 'show';
    await i.store.update(GETTING_STARTED_KEY, visibility);
  }
  const items: GettingStartedItems = {
    connect: i.agentReady,
    mode: i.modeChosen,
    task: typeof i.messagesSent === 'number' && i.messagesSent > 0,
    mention: i.store.get<boolean>(USED_MENTION_KEY) === true,
  };
  const allDone = Object.values(items).every(Boolean);
  return {
    tips: { enabled: i.tipsEnabled, seen: seenTips(i.store) },
    gettingStarted: visibility === 'show' && !allDone ? { items } : null,
  };
}
```

- [ ] **Step 4: Run — expect PASS**: `npx vitest run tests/chat/onboarding.test.ts`
- [ ] **Step 5: Commit** — `git add src/chat/onboarding.ts tests/chat/onboarding.test.ts && git commit -m "feat(onboarding): host state for tips, getting started and mention flag"`

---

### Task 2: Host wiring — initialState, messages, readiness, `Mysti: Get Started`, `mysti.tips.enabled`

**Files:**
- Modify: `src/providers/ChatViewProvider.ts` — imports; `_sendInitialState` (the `mystiReady`/`showWizard` block and the `initialState` payload); `_handleMessage` (next to `case 'dismissWizard'`); `_handleSendMessage` (after `trackMessageSent`); `setDeepMystAuth`; new public `showOnboarding`.
- Modify: `src/extension.ts` — register `mysti.getStarted` next to `mysti.deepmyst.signIn`.
- Modify: `package.json` — `contributes.commands` + `contributes.configuration.properties["mysti.tips.enabled"]`.
- Test: append to `tests/integration/chatViewWizardRouting.test.ts` (reuses its `createHarness`).

**Interfaces:**
- Consumes (Task 1): `onboardingSnapshot`, `markTipSeen`, `hideGettingStarted`, `recordAgentMention`, `isTipId`, `isWizardStep`, `hasChosenMode`, `WizardStep`.
- Produces for the webview: `initialState.payload.onboarding: OnboardingSnapshot`; `showWizard.payload.mystiReady: boolean`, `showWizard.payload.step?: WizardStep`; broadcast `{ type: 'mystiReadyChanged', payload: { ready } }`.
- Accepts from the webview: `tipSeen {id}`, `tipsOff`, `hideGettingStarted`, `openWalkthrough`, `requestOnboarding {step?}`.
- `ChatViewProvider.showOnboarding(step?: WizardStep, panelId = this._sidebarId): Promise<void>`.

- [ ] **Step 1: Failing tests** — append to `tests/integration/chatViewWizardRouting.test.ts` inside the top-level `describe`:

```ts
  describe('Plan 32 onboarding wiring', () => {
    function useStore(): Map<string, unknown> {
      const m = new Map<string, unknown>();
      (h.provider as any)._extensionContext.globalState = {
        get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
        update: async (k: string, v: unknown) => { m.set(k, v); },
      };
      return m;
    }

    it('initialState carries the onboarding snapshot', async () => {
      useStore();
      await (h.provider as any)._sendInitialState('sidebar');
      const init = h.sidebarMessages.find(m => m.type === 'initialState');
      expect(init!.payload.onboarding.tips).toEqual({ enabled: true, seen: [] });
      expect(init!.payload.onboarding.gettingStarted.items.connect).toBe(false);
    });

    it('showWizard says whether the Mysti agent is ready', async () => {
      await (h.provider as any)._sendInitialState('sidebar');
      expect(h.sidebarMessages.find(m => m.type === 'showWizard')!.payload.mystiReady).toBe(false);
    });

    it('tipSeen stores known ids only', async () => {
      const m = useStore();
      await (h.provider as any)._handleMessage({ type: 'tipSeen', panelId: 'sidebar', payload: { id: 'rewind' } });
      await (h.provider as any)._handleMessage({ type: 'tipSeen', panelId: 'sidebar', payload: { id: 'x'.repeat(5000) } });
      expect(m.get('mysti.tips.seen')).toEqual(['rewind']);
    });

    it('tipsOff turns the setting off globally', async () => {
      await (h.provider as any)._handleMessage({ type: 'tipsOff', panelId: 'sidebar' });
      expect(getMockConfigUpdates()['tips.enabled']).toBe(false);
    });

    it('hideGettingStarted persists', async () => {
      const m = useStore();
      await (h.provider as any)._handleMessage({ type: 'hideGettingStarted', panelId: 'sidebar' });
      expect(m.get('mysti.gettingStarted')).toBe('hidden');
    });

    it('Get Started opens the wizard on the requested step even after a dismissal', async () => {
      const m = useStore();
      m.set('mysti.setupWizardDismissed', true);
      await h.provider.showOnboarding('mode');
      const shown = h.sidebarMessages.filter(x => x.type === 'showWizard').pop();
      expect(shown!.payload).toMatchObject({ panelId: 'sidebar', step: 'mode', mystiReady: false });
    });

    it('requestOnboarding from a panel opens the wizard in that panel', async () => {
      await (h.provider as any)._handleMessage({ type: 'requestOnboarding', panelId: 'sidebar', payload: { step: 'bogus' } });
      const shown = h.sidebarMessages.filter(x => x.type === 'showWizard').pop();
      expect(shown!.payload.step).toBe('connect');
    });
  });
```

- [ ] **Step 2: Run — expect FAIL**: `npx vitest run tests/integration/chatViewWizardRouting.test.ts`

- [ ] **Step 3: Implement.**

`src/providers/ChatViewProvider.ts` — import beside the other `../chat/` imports:

```ts
import {
  onboardingSnapshot, markTipSeen, hideGettingStarted, recordAgentMention,
  isTipId, isWizardStep, hasChosenMode, type WizardStep,
} from '../chat/onboarding';
```

In `_sendInitialState`, the `showWizard` post gains `mystiReady`:

```ts
this._postToPanel(panelId, { type: 'showWizard', payload: { ...fullStatus, panelId, mystiReady } });
```

Right after `const providerAvailability = this._buildProviderAvailability(wizardStatus);`:

```ts
    // Plan 32: the walkthrough's "Connect an agent" step completes on this key.
    const agentReady = wizardStatus.anyReady || mystiReady;
    void vscode.commands.executeCommand('setContext', 'mysti.agentReady', agentReady);
    const onboarding = await onboardingSnapshot({
      store: this._extensionContext.globalState,
      tipsEnabled: config.get<boolean>('tips.enabled', true),
      hasCompletedSetup: this._extensionContext.globalState.get<boolean>('mysti.hasCompletedSetup', false),
      agentReady,
      modeChosen: hasChosenMode(config),
      messagesSent: Number(this._engagementManager.getUsageStats()?.totalMessages) || 0,
    });
```

and `onboarding,` in the `initialState` payload (after `providerAvailability,`). At the END of `_sendInitialState`, flush a Get Started request that arrived before the panel existed:

```ts
    if (panelId === this._sidebarId && this._pendingOnboardingStep) {
      const step = this._pendingOnboardingStep;
      this._pendingOnboardingStep = undefined;
      await this._postOnboarding(panelId, step);
    }
```

Field near `_sidebarId`: `private _pendingOnboardingStep?: WizardStep;`

New methods (after `_handleDismissWizard`):

```ts
  /**
   * Plan 32: `Mysti: Get Started` and the walkthrough's buttons. Always opens
   * the wizard — deliberately ignores `mysti.setupWizardDismissed`, which only
   * stops the wizard from raising ITSELF on panel load.
   */
  public async showOnboarding(step?: WizardStep, panelId: string = this._sidebarId): Promise<void> {
    if (panelId === this._sidebarId) {
      await vscode.commands.executeCommand('mysti.chatView.focus');
    }
    if (!this._panelStates.has(panelId)) {
      // The sidebar view is resolving; `_sendInitialState` flushes this.
      this._pendingOnboardingStep = step ?? 'connect';
      return;
    }
    await this._postOnboarding(panelId, step ?? 'connect');
  }

  private async _postOnboarding(panelId: string, step: WizardStep): Promise<void> {
    const status = await this._setupManager.getWizardStatus();
    const mystiReady = this._mystiCoordinator?.status().ready === true;
    this._postToPanel(panelId, { type: 'showWizard', payload: { ...status, panelId, mystiReady, step } });
  }
```

`_handleMessage` cases (next to `case 'dismissWizard'`):

```ts
      case 'tipSeen': {
        const id = (msg.payload as { id?: unknown } | undefined)?.id;
        if (isTipId(id)) { await markTipSeen(this._extensionContext.globalState, id); }
        break;
      }
      case 'tipsOff':
        await vscode.workspace.getConfiguration('mysti').update('tips.enabled', false, vscode.ConfigurationTarget.Global);
        break;
      case 'hideGettingStarted':
        await hideGettingStarted(this._extensionContext.globalState);
        break;
      case 'openWalkthrough':
        void vscode.commands.executeCommand('workbench.action.openWalkthrough', 'DeepMyst.mysti#mysti.gettingStarted', false);
        break;
      case 'requestOnboarding': {
        const step = (msg.payload as { step?: unknown } | undefined)?.step;
        await this.showOnboarding(isWizardStep(step) ? step : undefined, msg.panelId);
        break;
      }
```

`_handleSendMessage`, right after `this._emitBadgeUnlocks(panelId, badgeEvents);`:

```ts
    if (mentions?.some(m => m.type === 'agent')) {
      void recordAgentMention(this._extensionContext.globalState);
    }
```

`setDeepMystAuth` — extend the existing listener:

```ts
    auth.onDidChangeAuth(() => {
      this._connectionsCache = undefined; this._mcpToolsCache = undefined;
      // Plan 32: an open wizard enables Continue the moment sign-in lands.
      const ready = this._mystiCoordinator?.status().ready === true;
      this._broadcastToAll({ type: 'mystiReadyChanged', payload: { ready } });
      if (ready) { void vscode.commands.executeCommand('setContext', 'mysti.agentReady', true); }
    });
```

`src/extension.ts`, beside `mysti.deepmyst.signIn`:

```ts
    vscode.commands.registerCommand('mysti.getStarted', (step?: unknown) =>
      chatViewProvider.showOnboarding(isWizardStep(step) ? step : undefined)),
```

(import `isWizardStep` from `./chat/onboarding`.)

`package.json` — commands: `{ "command": "mysti.getStarted", "title": "Get Started", "category": "Mysti" }`; configuration property:

```json
"mysti.tips.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Show a one-line tip the first time you meet a Mysti feature: approvals, @-mentions, rewind, Brainstorm and compaction. Each tip appears once."
}
```

- [ ] **Step 4: Run — expect PASS**: `npx vitest run tests/integration/chatViewWizardRouting.test.ts && npm run typecheck`
- [ ] **Step 5: Commit** — `git commit -am "feat(onboarding): host wiring, Mysti: Get Started, tips setting"`

---

### Task 3: `/mode plan|ask|auto|full` and `/help` → `showHelp`

**Files:**
- Modify: `src/managers/SlashCommandManager.ts` — `case 'cmd:help'`, `case 'settings:mode'`, delete `_getHelpText`, `/help` description.
- Test: `tests/managers/slashCommandModeHelp.test.ts`

**Interfaces:**
- Consumes: `isTrustStop`, `authorityForTrust`, `TRUST_COPY` from `src/utils/trustLadder.ts`.
- Produces: webview message `{ type: 'showHelp' }` (rendered in Task 9).

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { SlashCommandManager } from '../../src/managers/SlashCommandManager';

function makeManager() {
  return new SlashCommandManager({
    providerManager: { getAllProviders: () => [] } as any,
    contextManager: {} as any, conversationManager: {} as any, compactionManager: {} as any,
    memoryManager: {} as any, brainstormManager: {} as any,
  });
}
function callbacks(updates: Array<Record<string, unknown>>, posted: unknown[]) {
  return {
    postToPanel: (_p: string, m: unknown) => { posted.push(m); },
    updateSettings: async (s: Record<string, unknown>) => { updates.push(s); },
    getPanelProvider: () => 'x', getPanelModel: () => 'm', getModelsForProvider: () => [],
    executeManualCompaction: async () => {},
  };
}

describe('/mode speaks the four mode names', () => {
  beforeEach(() => clearMockConfig());
  it.each([
    ['plan', { mode: 'quick-plan', accessLevel: 'read-only' }],
    ['ask', { mode: 'ask-before-edit', accessLevel: 'ask-permission' }],
    ['auto', { mode: 'edit-automatically', accessLevel: 'ask-permission' }],
    ['full', { mode: 'edit-automatically', accessLevel: 'full-access' }],
  ])('/mode %s writes mode AND access', async (arg, expected) => {
    const updates: Array<Record<string, unknown>> = [];
    const out = await makeManager().executeCommand('settings:mode', arg, 'p', callbacks(updates, []) as any);
    expect(updates).toEqual([expected]);
    expect(out).toMatch(new RegExp(`^Mode: ${arg[0].toUpperCase()}${arg.slice(1)}`));
  });
  it('keeps detailed-plan when landing on plan from it', async () => {
    setMockConfig('defaultMode', 'detailed-plan');
    const updates: Array<Record<string, unknown>> = [];
    await makeManager().executeCommand('settings:mode', 'plan', 'p', callbacks(updates, []) as any);
    expect(updates[0]).toEqual({ mode: 'detailed-plan', accessLevel: 'read-only' });
  });
  it('still accepts a raw mode value', async () => {
    const updates: Array<Record<string, unknown>> = [];
    await makeManager().executeCommand('settings:mode', 'edit-automatically', 'p', callbacks(updates, []) as any);
    expect(updates).toEqual([{ mode: 'edit-automatically' }]);
  });
  it('names the four modes when the argument is wrong', async () => {
    const out = await makeManager().executeCommand('settings:mode', 'turbo', 'p', callbacks([], []) as any);
    expect(out).toContain('plan, ask, auto or full');
  });
});

describe('/help opens the help card', () => {
  it('posts showHelp and returns no text', async () => {
    const posted: unknown[] = [];
    const out = await makeManager().executeCommand('cmd:help', '', 'p', callbacks([], posted) as any);
    expect(posted).toEqual([{ type: 'showHelp' }]);
    expect(out).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `npx vitest run tests/managers/slashCommandModeHelp.test.ts`
- [ ] **Step 3: Implement**

```ts
      case 'cmd:help':
        callbacks.postToPanel(panelId, { type: 'showHelp' });
        return;
```

```ts
      case 'settings:mode': {
        if (trimmedArgs) {
          if (isTrustStop(trimmedArgs)) {
            // Plan 32: the same pair the mode pill writes — a mode-only write
            // would leave access on whatever tier it was on before.
            const current = vscode.workspace.getConfiguration('mysti').get<OperationMode>('defaultMode');
            await callbacks.updateSettings({ ...authorityForTrust(trimmedArgs, current) });
            const copy = TRUST_COPY[trimmedArgs];
            return `Mode: ${copy.label}. ${copy.permits}`;
          }
          const modes = ['ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'];
          if (modes.includes(trimmedArgs)) {
            await callbacks.updateSettings({ mode: trimmedArgs });
            return `Mode changed to: ${trimmedArgs}`;
          }
          return `Invalid mode. Use plan, ask, auto or full (or a raw mode: ${modes.join(', ')}).`;
        }
        // (QuickPick branch unchanged)
```

Delete `_getHelpText()`. Change the `/help` catalog description to `'Search Mysti help'`. Imports: `isTrustStop, authorityForTrust, TRUST_COPY` from `'../utils/trustLadder'`; `OperationMode` from `'../types'` if not already imported.

- [ ] **Step 4: Run — PASS**: `npx vitest run tests/managers/ && npm run typecheck`
- [ ] **Step 5: Commit** — `git commit -am "feat(slash): /mode takes plan|ask|auto|full; /help opens the help card"`

---

### Task 4: Browser harness helper — `tests/webview/chatPageHtml.ts`

**Files:**
- Create: `tests/webview/chatPageHtml.ts` — exports `composeChatHtml(): string` and `INITIAL_STATE` (the `initialState` payload the composer suite sends). Body is `bootPayload()` + `composeHtml()` moved verbatim from `tests/webview/chatComposerBrowser.test.ts` (functions, not string, replacers — keep the comment about `$&`).
- Test: covered by Task 5's suite booting with no page errors.

(Folded into Task 5's commit; it has no behaviour of its own. `chatComposerBrowser.test.ts` is NOT edited — Plan 31 is editing the neighbouring suites.)

---

### Task 5: Wizard step 1 — sections, groups, filter, four new cards, gated Continue

**Files:**
- Modify: `media/chat/index.html` — `#setup-wizard` content.
- Modify: `media/chat/chat.js` — `state.wizard` init, `handleShowWizard`, `renderWizard`, `handleWizardComplete`, `updateWizardActionButton`, new `placeWizardCards`, `filterWizardCards`, `updateWizardNav`, `showWizardStep`, `setMystiReady`, `case 'mystiReadyChanged'`.
- Modify: `media/chat/chat.css` — wizard stepper, sections, compact cards, footer nav.
- Test: `tests/webview/onboardingBrowser.test.ts` (create).

**Interfaces:**
- Consumes (Task 2): `showWizard.payload.{mystiReady, step}`, `mystiReadyChanged`.
- Produces: `showWizardStep(step)`, `updateWizardNav()`, `state.wizard.{step, selected, mystiReady}` used by Task 6.

Markup (inside `.wizard-content`, replacing header → footer):

```html
<div class="wizard-header">
  <img src="{{resourceBase}}/Mysti-Logo.png" alt="Mysti" class="wizard-logo" />
  <h2>Welcome to Mysti</h2>
  <p class="wizard-subtitle">One chat for every AI coding agent you use. Connect one to start — it takes about a minute.</p>
</div>
<ol class="wizard-stepper" aria-label="Setup steps">
  <li data-step="connect">Connect</li><li data-step="mode">Mode</li><li data-step="task">First task</li>
</ol>
<section class="wizard-step" data-step="connect" aria-label="Connect an agent">
  <div id="wizard-found" class="wizard-section hidden">
    <h3 class="wizard-section-label">Found on this machine</h3>
    <div id="wizard-found-list" class="wizard-card-list"></div>
  </div>
  <!-- existing wizard-fastpath block, plus: -->
  <!--   <p id="wizard-mysti-status" class="wizard-mysti-status hidden">Signed in · free model ready</p> -->
  <!-- existing #wizard-prerequisites -->
  <div id="wizard-recommended-section" class="wizard-section">
    <h3 class="wizard-section-label">Or install one</h3>
    <div id="wizard-recommended" class="wizard-card-list"></div>
  </div>
  <details id="wizard-all" class="wizard-all">
    <summary>See all 15 agents</summary>
    <label for="wizard-filter" class="wizard-field-label">Filter agents</label>
    <input id="wizard-filter" type="search" class="wizard-filter" placeholder="Name, plan or “local”" autocomplete="off" />
    <!-- allow-start marker (existing) -->
    <div class="wizard-providers">
      <h4 class="wizard-group-label" data-group="subscription">Use a plan you already pay for</h4>
      <!-- cards: claude-code (data-recommended), openai-codex, google-gemini (data-recommended), github-copilot, cursor, qwen-code (NEW), kimi-code — each data-group="subscription" -->
      <h4 class="wizard-group-label" data-group="open">Open-source agents · bring a model</h4>
      <!-- cline, opencode (NEW), openclaw, hermes, continue — data-group="open" -->
      <h4 class="wizard-group-label" data-group="local">Run models on this machine</h4>
      <!-- ollama (NEW, data-recommended), localai (NEW) — data-group="local" -->
      <h4 class="wizard-group-label" data-group="key">One API key, many models</h4>
      <!-- openrouter — data-group="key" -->
    </div>
    <!-- allow-end marker (existing) -->
    <p id="wizard-filter-empty" class="wizard-filter-empty hidden">No agent matches that.</p>
  </details>
  <!-- existing #auth-options-modal -->
</section>
<!-- Task 6 adds the mode + task sections here -->
<div class="wizard-footer">
  <div class="wizard-nav">
    <button type="button" class="wizard-skip-btn">Skip for now</button>
    <span class="wizard-nav-spacer"></span>
    <button type="button" id="wizard-back-btn" class="wizard-nav-btn hidden">Back</button>
    <button type="button" id="wizard-next-btn" class="wizard-nav-btn primary" disabled>Continue</button>
  </div>
  <button class="wizard-diagnose-btn">&#128269; Run Diagnostics</button>
  <div id="diagnostics-panel" class="diagnostics-panel hidden"></div>
</div>
```

Card descriptions become the "how you pay" line (plain words): Claude Code "Claude plan or Anthropic API key"; OpenAI Codex "ChatGPT plan or OpenAI API key"; Google Gemini "Sign in with Google"; GitHub Copilot "Copilot plan"; Cursor "Cursor account"; Qwen Code "Qwen account"; Kimi Code "Kimi account"; Cline / OpenCode "Any provider key"; OpenClaw "Runs a local gateway"; Hermes "Nous Portal or your own key"; Continue "Models from ~/.continue/config.yaml"; Ollama "Local models, works offline"; LocalAI "Local models via Docker"; OpenRouter "Hundreds of models behind one key". New cards copy the existing card skeleton (header/status/desc/steps/progress/error/actions) with icons `icons/qwen.png`, `icons/opencode.png`, `icons/ollama.png`, `icons/localai.png`.

chat.js:

```js
      var WIZARD_STEPS = ['connect', 'mode', 'task'];

      function wizardAgentReady() {
        return !!(state.wizard.anyReady || state.wizard.mystiReady);
      }

      /** Plan 32: move each existing card into Found / Or install one; the rest stay grouped. */
      function placeWizardCards() {
        var found = document.getElementById('wizard-found-list');
        var rec = document.getElementById('wizard-recommended');
        if (!found || !rec) { return; }
        var byId = {};
        (state.wizard.providers || []).forEach(function(p) { byId[p.providerId] = p; });
        document.querySelectorAll('#setup-wizard .provider-card').forEach(function(card) {
          var p = byId[card.getAttribute('data-provider')];
          // ponytail: cards only move toward Found; one uninstalled mid-wizard stays put.
          if (p && p.installed) {
            if (card.parentNode !== found) { found.appendChild(card); }
          } else if (card.hasAttribute('data-recommended') && card.parentNode !== found && card.parentNode !== rec) {
            rec.appendChild(card);
          }
        });
        document.getElementById('wizard-found').classList.toggle('hidden', !found.children.length);
        document.getElementById('wizard-recommended-section').classList.toggle('hidden', !rec.children.length);
        filterWizardCards();
      }

      function filterWizardCards() {
        var input = document.getElementById('wizard-filter');
        var q = input ? input.value.trim().toLowerCase() : '';
        var list = document.querySelector('#setup-wizard .wizard-providers');
        if (!list) { return; }
        var visibleByGroup = {};
        var any = false;
        list.querySelectorAll('.provider-card').forEach(function(card) {
          var group = card.getAttribute('data-group') || '';
          var label = list.querySelector('.wizard-group-label[data-group="' + group + '"]');
          var hay = (card.textContent + ' ' + (label ? label.textContent : '')).toLowerCase();
          var show = !q || hay.indexOf(q) !== -1;
          card.classList.toggle('hidden', !show);
          if (show) { visibleByGroup[group] = true; any = true; }
        });
        list.querySelectorAll('.wizard-group-label').forEach(function(label) {
          label.classList.toggle('hidden', !visibleByGroup[label.getAttribute('data-group')]);
        });
        var empty = document.getElementById('wizard-filter-empty');
        if (empty) { empty.classList.toggle('hidden', any); }
      }

      function setMystiReady(ready) {
        state.wizard.mystiReady = !!ready;
        var block = document.querySelector('#setup-wizard .wizard-fastpath');
        var btn = document.getElementById('wizard-signin-btn');
        var status = document.getElementById('wizard-mysti-status');
        if (block) { block.classList.toggle('ready', !!ready); }
        if (btn) { btn.classList.toggle('hidden', !!ready); }
        if (status) { status.classList.toggle('hidden', !ready); }
        updateWizardNav();
      }

      function showWizardStep(step) {
        if (WIZARD_STEPS.indexOf(step) === -1) { step = 'connect'; }
        state.wizard.step = step;
        var idx = WIZARD_STEPS.indexOf(step);
        document.querySelectorAll('#setup-wizard .wizard-step').forEach(function(s) {
          s.classList.toggle('hidden', s.getAttribute('data-step') !== step);
        });
        document.querySelectorAll('#setup-wizard .wizard-stepper li').forEach(function(li) {
          var i = WIZARD_STEPS.indexOf(li.getAttribute('data-step'));
          li.classList.toggle('done', i < idx);
          li.classList.toggle('current', i === idx);
          if (i === idx) { li.setAttribute('aria-current', 'step'); } else { li.removeAttribute('aria-current'); }
        });
        if (step === 'mode' && typeof renderWizardModeStep === 'function') { renderWizardModeStep(); }
        if (step === 'task' && typeof renderWizardTaskStep === 'function') { renderWizardTaskStep(); }
        updateWizardNav();
      }

      function updateWizardNav() {
        var back = document.getElementById('wizard-back-btn');
        var next = document.getElementById('wizard-next-btn');
        if (!back || !next) { return; }
        var step = state.wizard.step || 'connect';
        back.classList.toggle('hidden', step === 'connect');
        next.textContent = step === 'task' ? 'Start chatting' : 'Continue';
        next.disabled = step === 'connect' && !wizardAgentReady();
        next.title = next.disabled ? 'Connect an agent first' : '';
      }
```

`state.wizard` init gains `step: 'connect', selected: null, mystiReady: false`. `handleShowWizard(payload)` sets `state.wizard.mystiReady = !!payload.mystiReady`, calls `renderWizard()`, then `showWizardStep(payload.step || (wasVisible ? state.wizard.step : 'connect'))` (capture `wasVisible` before setting `visible`). `renderWizard()` calls `placeWizardCards()` after `updateWizardProviderCards()` and `setMystiReady(state.wizard.mystiReady)`. `handleWizardStatus` calls `placeWizardCards(); updateWizardNav();` when visible. `handleWizardComplete(payload)` becomes:

```js
      function handleWizardComplete(payload) {
        // Plan 32 (D4): choosing an agent no longer closes the wizard.
        state.wizard.selected = payload && payload.providerId || null;
        updateWizardProviderCards();
        updateWizardNav();
      }
```

`updateWizardActionButton`: when `state.wizard.selected === provider.providerId` and status is `ready`/`complete`, use `{ text: 'Selected', action: null, disabled: true, success: true }`.

Bind once (with the other static wizard bindings, not inline):

```js
      var wizardFilter = document.getElementById('wizard-filter');
      if (wizardFilter) { wizardFilter.addEventListener('input', filterWizardCards); }
      var wizardNextBtn = document.getElementById('wizard-next-btn');
      if (wizardNextBtn) {
        wizardNextBtn.addEventListener('click', function() {
          var i = WIZARD_STEPS.indexOf(state.wizard.step || 'connect');
          if (i >= WIZARD_STEPS.length - 1) { finishWizard(); } else { showWizardStep(WIZARD_STEPS[i + 1]); }
        });
      }
      var wizardBackBtn = document.getElementById('wizard-back-btn');
      if (wizardBackBtn) {
        wizardBackBtn.addEventListener('click', function() {
          var i = WIZARD_STEPS.indexOf(state.wizard.step || 'connect');
          showWizardStep(WIZARD_STEPS[Math.max(0, i - 1)]);
        });
      }
```

`finishWizard()` (Task 6 fills in behaviour; Task 5 ships `function finishWizard() { hideWizard(); }`). Message: `case 'mystiReadyChanged': setMystiReady(message.payload && message.payload.ready); break;`

CSS (append after `.wizard-diagnose-btn` rules): `.wizard-stepper` (3-column grid, bar per item via `::before`, `.current`/`.done` use `--vscode-focusBorder`), `.wizard-section-label` (11px uppercase `--vscode-descriptionForeground`), `.wizard-card-list` (column, gap 8px), `.wizard-all > summary` (link-coloured, cursor pointer), `.wizard-filter` (input tokens), `.wizard-group-label`, `.wizard-fastpath.ready` (border `--vscode-charts-green`), `.wizard-nav` (flex, gap), `.wizard-nav-btn.primary` (button tokens), `.wizard-nav-btn:disabled` (opacity .5), compact cards: `#setup-wizard .provider-card { padding: 10px 12px; }` and `.provider-desc { margin: 0 0 8px; }`.

- [ ] **Step 1: Failing browser suite** — `tests/webview/onboardingBrowser.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';

let browser: Browser | undefined;
const dirs: string[] = [];
const errors: string[] = [];

async function panel(initial: Record<string, unknown> = {}): Promise<Page> {
  const pg = await (await browser!.newContext()).newPage();
  pg.on('pageerror', (e) => errors.push(String(e)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-onb-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'chat.html'), composeChatHtml(), 'utf8');
  await pg.goto(`file://${path.join(dir, 'chat.html')}`, { waitUntil: 'load' });
  await send(pg, { type: 'initialState', payload: { ...INITIAL_STATE, ...initial } });
  await pg.waitForSelector('#init-loading-overlay.hidden', { state: 'attached' });
  return pg;
}
async function send(pg: Page, m: Record<string, unknown>) {
  await pg.evaluate((msg) => window.dispatchEvent(new MessageEvent('message', { data: msg })), m);
}
async function posted(pg: Page): Promise<Array<Record<string, any>>> {
  return pg.evaluate(() => (window as any).__posted);
}
const PROVIDERS = (installed: string[], ready: string[]) =>
  ['claude-code', 'openai-codex', 'google-gemini', 'ollama', 'openrouter'].map((id) => ({
    providerId: id, installed: installed.includes(id), authenticated: ready.includes(id),
  }));

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 60000);
afterAll(async () => {
  await browser?.close();
  for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
});

describe('wizard step 1', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('puts found CLIs first, suggestions next, the rest behind See all', async () => {
    const pg = await panel();
    await send(pg, { type: 'showWizard', payload: { panelId: 'sidebar', providers: PROVIDERS(['openai-codex'], []), npmAvailable: true, anyReady: false, mystiReady: false } });
    expect(await pg.$$eval('#wizard-found-list .provider-card', (c) => c.map((x) => x.getAttribute('data-provider')))).toEqual(['openai-codex']);
    expect(await pg.$$eval('#wizard-recommended .provider-card', (c) => c.map((x) => x.getAttribute('data-provider')))).toEqual(['claude-code', 'google-gemini', 'ollama']);
    expect(await pg.$$eval('#wizard-all .provider-card', (c) => c.length)).toBe(11);
    expect(errors).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps Continue disabled until an agent is ready, then enables it on DeepMyst sign-in', async () => {
    const pg = await panel();
    await send(pg, { type: 'showWizard', payload: { panelId: 'sidebar', providers: PROVIDERS([], []), npmAvailable: true, anyReady: false, mystiReady: false } });
    expect(await pg.isDisabled('#wizard-next-btn')).toBe(true);
    await send(pg, { type: 'mystiReadyChanged', payload: { ready: true } });
    expect(await pg.isDisabled('#wizard-next-btn')).toBe(false);
    expect(await pg.isVisible('#wizard-mysti-status')).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('choosing an agent marks it and leaves the wizard open', async () => {
    const pg = await panel();
    await send(pg, { type: 'showWizard', payload: { panelId: 'sidebar', providers: PROVIDERS(['claude-code'], ['claude-code']), npmAvailable: true, anyReady: true, mystiReady: false } });
    await pg.click('#wizard-found-list .provider-card[data-provider="claude-code"] .provider-action-btn');
    expect((await posted(pg)).some((m) => m.type === 'selectProvider')).toBe(true);
    await send(pg, { type: 'wizardComplete', payload: { providerId: 'claude-code' } });
    expect(await pg.isVisible('#setup-wizard')).toBe(true);
    expect(await pg.textContent('#wizard-found-list .provider-action-btn')).toBe('Selected');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('filters the full list and hides empty groups', async () => {
    const pg = await panel();
    await send(pg, { type: 'showWizard', payload: { panelId: 'sidebar', providers: PROVIDERS([], []), npmAvailable: true, anyReady: false, mystiReady: false } });
    await pg.click('#wizard-all > summary');
    await pg.fill('#wizard-filter', 'offline');
    const visible = await pg.$$eval('#wizard-all .provider-card:not(.hidden)', (c) => c.map((x) => x.getAttribute('data-provider')));
    expect(visible).toEqual([]); // ollama moved to suggestions; nothing else says offline
    expect(await pg.isVisible('#wizard-filter-empty')).toBe(true);
    await pg.fill('#wizard-filter', 'local');
    expect(await pg.$$eval('#wizard-all .provider-card:not(.hidden)', (c) => c.map((x) => x.getAttribute('data-provider')))).toContain('localai');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('opens on the step Get Started asked for', async () => {
    const pg = await panel();
    await send(pg, { type: 'showWizard', payload: { panelId: 'sidebar', providers: [], npmAvailable: true, anyReady: true, mystiReady: false, step: 'mode' } });
    expect(await pg.isVisible('.wizard-step[data-step="mode"]')).toBe(true);
    expect(await pg.getAttribute('.wizard-stepper li[data-step="mode"]', 'aria-current')).toBe('step');
  });
});
```

(`INITIAL_STATE` = the composer suite's `initialState` payload.)

- [ ] **Step 2: Run — FAIL**: `npx vitest run tests/webview/onboardingBrowser.test.ts`
- [ ] **Step 3: Implement the markup, JS and CSS above.**
- [ ] **Step 4: Run — PASS**: `npx vitest run tests/webview/onboardingBrowser.test.ts tests/webview/wizardZeroInstallPath.test.ts tests/webview/wizardPanelId.test.ts tests/webview/inlineHandlerCsp.test.ts && node scripts/check-provider-literals.js`
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): wizard step 1 — found agents first, grouped list, gated Continue"`

---

### Task 6: Wizard steps 2 (mode) and 3 (first task), finishing

**Files:**
- Modify: `media/chat/index.html` — two `.wizard-step` sections after the connect section.
- Modify: `media/chat/chat.js` — `renderWizardModeStep`, `renderWizardTaskStep`, `finishWizard`, `sendQuickAction` (extracted from `renderWelcomeSuggestions`).
- Modify: `media/chat/chat.css` — `.wizard-modes`, `.wizard-mode`, `.wizard-caps`, `.wizard-warning`, `.wizard-note`, `.wizard-tasks`, `.wizard-tips`.
- Test: append to `tests/webview/onboardingBrowser.test.ts`.

**Interfaces:**
- Consumes: `CHAT_MODES`, `chatModeById`, `deriveChatMode`, `applyChatMode`, `WELCOME_SUGGESTIONS`, `sendMessage`, `showWizardStep`, `hideWizard`.
- Produces: `finishWizard()`; `sendQuickAction(suggestion)`; posts `openWalkthrough`.

Markup:

```html
<section class="wizard-step hidden" data-step="mode" aria-labelledby="wizard-mode-title">
  <h2 id="wizard-mode-title" class="wizard-step-title">How much should Mysti do on its own?</h2>
  <p class="wizard-step-sub">Change it any time from the mode pill under the chat box.</p>
  <fieldset class="wizard-modes"><legend class="sr-only">Mode</legend></fieldset>
  <h3 id="wizard-caps-title" class="wizard-section-label">On Ask, Mysti</h3>
  <dl id="wizard-caps" class="wizard-caps"></dl>
  <p id="wizard-full-warning" class="wizard-warning hidden">Full runs any command without asking. Keep it for projects you could throw away.</p>
  <p class="wizard-note"><strong>Every turn is checkpointed.</strong> Rewind a turn’s file changes from the ↺ on your message. Your own git history is never touched.</p>
</section>
<section class="wizard-step hidden" data-step="task" aria-labelledby="wizard-task-title">
  <h2 id="wizard-task-title" class="wizard-step-title">Give it a first task</h2>
  <p class="wizard-step-sub">Pick one to send now, or write your own. It runs on this workspace.</p>
  <div id="wizard-tasks" class="wizard-tasks"></div>
  <label for="wizard-task-input" class="wizard-field-label">Or write your own</label>
  <div class="wizard-task-compose">
    <textarea id="wizard-task-input" rows="2" placeholder="Explain what this project does"></textarea>
    <button type="button" id="wizard-task-send" class="wizard-nav-btn primary">Send</button>
  </div>
  <h3 class="wizard-section-label">Three things worth knowing</h3>
  <ul class="wizard-tips">
    <li><span class="wizard-tip-key">@</span><span><strong>Mention an agent.</strong> Start a message with @codex or @gemini to send just that message to another agent.</span></li>
    <li><span class="wizard-tip-key">/</span><span><strong>Slash for commands.</strong> Mysti’s own, plus your agent’s — like /compact.</span></li>
    <li><span class="wizard-tip-key">⇄</span><span><strong>Brainstorm.</strong> Two agents answer, challenge each other, then agree on one answer.</span></li>
  </ul>
  <button type="button" id="wizard-tour-btn" class="wizard-link-btn">Take the full tour · 2 min</button>
</section>
```

chat.js:

```js
      var WIZARD_CAP_ROWS = ['Reads your code', 'Edits files', 'Runs commands', 'Reaches the network'];
      var WIZARD_CAPS = {
        plan: ['yes', 'never', 'never', 'never'],
        ask: ['yes', 'asks', 'asks', 'asks'],
        auto: ['yes', 'workspace', 'asks', 'asks'],
        full: ['yes', 'yes', 'yes', 'yes']
      };
      var WIZARD_CAP_TEXT = { yes: 'Without asking', workspace: 'In this workspace', asks: 'Asks you first', never: 'Never' };

      function renderWizardCaps(id) {
        var def = chatModeById(id) || chatModeById('ask');
        var title = document.getElementById('wizard-caps-title');
        var dl = document.getElementById('wizard-caps');
        if (title) { title.textContent = 'On ' + def.label + ', Mysti'; }
        if (dl) {
          dl.innerHTML = WIZARD_CAPS[def.id].map(function(v, i) {
            return '<div class="wizard-cap" data-cap="' + v + '"><dt>' + WIZARD_CAP_ROWS[i] + '</dt><dd>' + WIZARD_CAP_TEXT[v] + '</dd></div>';
          }).join('');
        }
        var warn = document.getElementById('wizard-full-warning');
        if (warn) { warn.classList.toggle('hidden', def.id !== 'full'); }
      }

      function renderWizardModeStep() {
        var fs = document.querySelector('#setup-wizard .wizard-modes');
        if (!fs) { return; }
        var current = deriveChatMode();
        if (!fs.querySelector('.wizard-mode')) {
          CHAT_MODES.forEach(function(m) {
            var label = document.createElement('label');
            label.className = 'wizard-mode';
            label.innerHTML = '<input type="radio" name="wizard-mode" value="' + m.id + '" />' +
              '<span class="wizard-mode-text"><span class="wizard-mode-label">' + escapeHtml(m.label) +
              (m.id === 'ask' ? ' <span class="wizard-chip">Recommended</span>' : '') + '</span>' +
              '<span class="wizard-mode-desc">' + escapeHtml(m.desc) + '</span></span>';
            label.querySelector('input').addEventListener('change', function() {
              applyChatMode(m.id);
              renderWizardCaps(m.id);
            });
            fs.appendChild(label);
          });
        }
        fs.querySelectorAll('input[name="wizard-mode"]').forEach(function(r) { r.checked = r.value === current; });
        renderWizardCaps(current);
      }

      var WIZARD_TASK_IDS = ['understand', 'review', 'tests', 'debug'];
      function renderWizardTaskStep() {
        var box = document.getElementById('wizard-tasks');
        if (!box || box.children.length) { return; }
        WIZARD_TASK_IDS.forEach(function(id) {
          var s = WELCOME_SUGGESTIONS.filter(function(x) { return x.id === id; })[0];
          if (!s) { return; }
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'welcome-card';
          b.innerHTML = '<div class="welcome-card-icon"><img src="' + (ICON_URIS[s.icon] || '') + '" alt="" /></div>' +
            '<div class="welcome-card-title">' + escapeHtml(s.title) + '</div>' +
            '<div class="welcome-card-desc">' + escapeHtml(s.description) + '</div>';
          b.addEventListener('click', function() { finishWizard(); sendQuickAction(s); });
          box.appendChild(b);
        });
      }

      function finishWizard() {
        hideWizard();
        if (typeof renderGettingStarted === 'function') { renderGettingStarted(); }
      }
```

`sendQuickAction(s)` = the body of the welcome card's `onclick` (post `quickActionWithConfig` with `getProviderMessage(s, state.settings.provider)`); `renderWelcomeSuggestions` calls it. Bindings: `#wizard-task-send` → if the textarea has text: `finishWizard(); inputEl.value = text; sendMessage();`; `#wizard-tour-btn` → `postMessageWithPanelId({ type: 'openWalkthrough' })`.

- [ ] **Step 1: Failing tests** (append):

```ts
describe('wizard steps 2 and 3', () => {
  async function atStep(step: string) {
    const pg = await panel();
    await send(pg, { type: 'showWizard', payload: { panelId: 'sidebar', providers: PROVIDERS(['claude-code'], ['claude-code']), npmAvailable: true, anyReady: true, mystiReady: false, step } });
    return pg;
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('mode step starts on the current mode and writes the pill pair', async () => {
    const pg = await atStep('mode');
    expect(await pg.isChecked('input[name="wizard-mode"][value="ask"]')).toBe(true);
    await pg.check('input[name="wizard-mode"][value="full"]');
    const upd = (await posted(pg)).filter((m) => m.type === 'updateSettings').pop();
    expect(upd!.payload).toEqual({ mode: 'edit-automatically', accessLevel: 'full-access' });
    expect(await pg.isVisible('#wizard-full-warning')).toBe(true);
    expect(await pg.textContent('#wizard-caps-title')).toBe('On Full, Mysti');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('Back and Continue walk the steps; the last button starts chatting', async () => {
    const pg = await atStep('connect');
    await pg.click('#wizard-next-btn');
    expect(await pg.isVisible('.wizard-step[data-step="mode"]')).toBe(true);
    await pg.click('#wizard-next-btn');
    expect(await pg.textContent('#wizard-next-btn')).toBe('Start chatting');
    await pg.click('#wizard-back-btn');
    expect(await pg.isVisible('.wizard-step[data-step="mode"]')).toBe(true);
    await pg.click('#wizard-next-btn');
    await pg.click('#wizard-next-btn');
    expect(await pg.isVisible('#setup-wizard')).toBe(false);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a starter task closes the wizard and sends the task', async () => {
    const pg = await atStep('task');
    await pg.click('#wizard-tasks .welcome-card >> nth=0');
    expect(await pg.isVisible('#setup-wizard')).toBe(false);
    expect((await posted(pg)).some((m) => m.type === 'quickActionWithConfig')).toBe(true);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('the tour button asks the host to open the walkthrough', async () => {
    const pg = await atStep('task');
    await pg.click('#wizard-tour-btn');
    expect((await posted(pg)).some((m) => m.type === 'openWalkthrough')).toBe(true);
  });
});
```

- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS** (`npx vitest run tests/webview/onboardingBrowser.test.ts tests/webview/inlineHandlerCsp.test.ts`)
- [ ] **Step 5: Commit** — `git commit -am "feat(onboarding): wizard mode and first-task steps"`

---

### Task 7: Getting-started card

**Files:**
- Modify: `media/chat/chat.js` — `renderGettingStarted()`; call it at the end of `initializeState` (after messages are restored) and in `clearMessages` after `renderWelcomeSuggestions()`.
- Modify: `media/chat/chat.css` — `.getting-started` block.
- Test: append to `tests/webview/onboardingBrowser.test.ts`.

**Interfaces:**
- Consumes: `state.onboarding.gettingStarted.items` (Task 2), `behaviorIndicator`, `deriveChatMode`, `chatModeById`, `getManifestEntry`.
- Produces: `renderGettingStarted()`; posts `hideGettingStarted`, `openWalkthrough`, `requestOnboarding`.

```js
      function renderGettingStarted() {
        var old = document.getElementById('getting-started');
        if (old) { old.remove(); }
        var gs = state.onboarding && state.onboarding.gettingStarted;
        var welcome = messagesEl.querySelector('.welcome-container');
        if (!gs || !welcome) { return; }
        var it = gs.items || {};
        var mode = chatModeById(deriveChatMode()) || chatModeById('ask');
        var rows = [
          { done: it.connect, title: 'Connect an agent', text: it.connect ? agentReadyText() : 'Pick one — or use the Mysti agent with nothing to install.', action: it.connect ? null : 'connect' },
          { done: it.mode, title: 'Choose how much Mysti may do', text: 'You’re on ' + mode.label + '. ' + mode.desc, action: 'mode' },
          { done: it.task, title: 'Send a first task', text: 'Pick a card below, or type in the box.' },
          { done: it.mention, title: 'Mention another agent', text: 'Type @ in the box to send one message to a different agent.' }
        ];
        var doneCount = rows.filter(function(r) { return r.done; }).length;
        var el = document.createElement('section');
        el.id = 'getting-started';
        el.className = 'getting-started';
        el.setAttribute('aria-label', 'Getting started');
        el.innerHTML =
          '<div class="gs-head"><div><div class="gs-title">Getting started</div><div class="gs-count">' + doneCount + ' of 4 done</div></div>' +
          '<button type="button" class="gs-close icon-btn" aria-label="Hide getting started">&times;</button></div>' +
          '<div class="gs-bar"><div class="gs-bar-fill" style="width:' + (doneCount * 25) + '%"></div></div>' +
          '<ol class="gs-list">' + rows.map(function(r) {
            return '<li class="gs-item' + (r.done ? ' done' : '') + '"><span class="gs-check" aria-hidden="true"></span>' +
              '<span class="gs-text"><span class="gs-item-title">' + escapeHtml(r.title) + (r.done ? '<span class="sr-only"> (done)</span>' : '') + '</span>' +
              '<span class="gs-item-sub">' + escapeHtml(r.text) + '</span></span>' +
              (r.action && !(r.done && r.action === 'connect') ? '<button type="button" class="gs-action" data-action="' + r.action + '">' + (r.action === 'mode' ? 'Change' : 'Connect') + '</button>' : '') +
              '</li>';
          }).join('') + '</ol>' +
          '<div class="gs-foot"><button type="button" class="gs-tour">Take the full tour</button><button type="button" class="gs-hide">Hide</button></div>';
        function hide() {
          state.onboarding.gettingStarted = null;
          el.remove();
          postMessageWithPanelId({ type: 'hideGettingStarted' });
        }
        el.querySelector('.gs-close').addEventListener('click', hide);
        el.querySelector('.gs-hide').addEventListener('click', hide);
        el.querySelector('.gs-tour').addEventListener('click', function() { postMessageWithPanelId({ type: 'openWalkthrough' }); });
        el.querySelectorAll('.gs-action').forEach(function(b) {
          b.addEventListener('click', function(e) {
            e.stopPropagation();
            if (b.getAttribute('data-action') === 'mode') { behaviorIndicator.click(); }
            else { postMessageWithPanelId({ type: 'requestOnboarding', payload: { step: 'connect' } }); }
          });
        });
        var suggestions = welcome.querySelector('.welcome-suggestions');
        welcome.insertBefore(el, suggestions || null);
      }

      function agentReadyText() {
        var p = state.settings && state.settings.provider;
        if (p === 'mysti') { return 'The Mysti agent is ready'; }
        var entry = p && getManifestEntry(p);
        return (entry ? entry.displayName : 'Your agent') + ' is ready';
      }
```

- [ ] **Step 1: Failing tests** (append):

```ts
describe('getting started card', () => {
  const gs = (items: Record<string, boolean>) => ({ onboarding: { tips: { enabled: true, seen: [] }, gettingStarted: { items } } });
  it.skipIf(CHROMIUM_UNAVAILABLE)('renders in the empty chat with the right count', async () => {
    const pg = await panel(gs({ connect: true, mode: false, task: false, mention: false }));
    expect(await pg.textContent('#getting-started .gs-count')).toBe('1 of 4 done');
    expect(await pg.$$eval('#getting-started .gs-item.done', (e) => e.length)).toBe(1);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('is absent when the host says null', async () => {
    const pg = await panel({ onboarding: { tips: { enabled: true, seen: [] }, gettingStarted: null } });
    expect(await pg.$('#getting-started')).toBeNull();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('Hide removes it, tells the host, and it stays gone on a new chat', async () => {
    const pg = await panel(gs({ connect: true, mode: false, task: false, mention: false }));
    await pg.click('#getting-started .gs-hide');
    expect(await pg.$('#getting-started')).toBeNull();
    expect((await posted(pg)).some((m) => m.type === 'hideGettingStarted')).toBe(true);
    await send(pg, { type: 'conversationCleared' });
    expect(await pg.$('#getting-started')).toBeNull();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('Change opens the mode picker', async () => {
    const pg = await panel(gs({ connect: true, mode: false, task: false, mention: false }));
    await pg.click('#getting-started .gs-action[data-action="mode"]');
    expect(await pg.isVisible('#behavior-popup')).toBe(true);
  });
});
```

(Use whichever message `clearMessages()` runs on — check `case '…'` that calls `clearMessages()`; the plan assumes `conversationCleared`; adjust the test to the real type.)

- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat(onboarding): getting-started card"`

---

### Task 8: Once-only hints

**Files:**
- Modify: `media/chat/chat.js` — `canShowTip`, `claimTip`, `buildTip`, and five triggers: `handlePermissionRequest`, `showMentionMenu`/`hideMentionMenu`, `case 'responseComplete'` (main switch), `updateStrategyIndicatorVisibility`, `handleCompactionStatus` `'complete'`.
- Modify: `media/chat/chat.css` — `.mysti-tip`, `.bs-strategies`.
- Test: append to `tests/webview/onboardingBrowser.test.ts`.

**Interfaces:**
- Consumes: `state.onboarding.tips` (Task 2); `strategyDescriptions`, `brainstormStrategySelect`, `updateStrategyIndicator`, `deriveChatMode`, `chatModeById`, `settingsBtn`, `#new-conversation-btn`.
- Produces: posts `tipSeen {id}` (on show) and `tipsOff`.

```js
      var TIP_INFO_SVG = '<svg class="mysti-tip-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4M8 4.9v.1"/></svg>';

      function canShowTip(id) {
        var t = state.onboarding && state.onboarding.tips;
        return !!t && t.enabled && (t.seen || []).indexOf(id) === -1 && !state.tipShownThisSession;
      }

      /** Seen on SHOW, one per session (Plan 32 D6). */
      function claimTip(id) {
        if (!canShowTip(id)) { return false; }
        state.tipShownThisSession = true;
        state.onboarding.tips.seen = (state.onboarding.tips.seen || []).concat([id]);
        postMessageWithPanelId({ type: 'tipSeen', payload: { id: id } });
        return true;
      }

      /** `extra` = optional { label, onClick } shown before Turn off tips. */
      function buildTip(id, html, extra) {
        var el = document.createElement('div');
        el.className = 'mysti-tip';
        el.setAttribute('role', 'note');
        el.setAttribute('data-tip', id);
        el.innerHTML = TIP_INFO_SVG + '<div class="mysti-tip-body"><p class="mysti-tip-text">' + html + '</p>' +
          '<div class="mysti-tip-actions"><button type="button" class="mysti-tip-ok">Got it</button>' +
          (extra ? '<button type="button" class="mysti-tip-extra">' + escapeHtml(extra.label) + '</button>' : '') +
          '<button type="button" class="mysti-tip-off">Turn off tips</button></div></div>';
        el.querySelector('.mysti-tip-ok').addEventListener('click', function() { el.remove(); });
        if (extra) { el.querySelector('.mysti-tip-extra').addEventListener('click', function() { el.remove(); extra.onClick(); }); }
        el.querySelector('.mysti-tip-off').addEventListener('click', function() {
          if (state.onboarding && state.onboarding.tips) { state.onboarding.tips.enabled = false; }
          postMessageWithPanelId({ type: 'tipsOff' });
          document.querySelectorAll('.mysti-tip').forEach(function(n) { n.remove(); });
        });
        return el;
      }
```

Triggers (copy is literal — no user text is interpolated):

1. `handlePermissionRequest`, before `messagesEl.appendChild(card)`:
   ```js
        if (claimTip('permission')) {
          var pm = chatModeById(deriveChatMode()) || chatModeById('ask');
          var canRemember = !request.forceInteractive && !request.remoteOrigin;
          messagesEl.appendChild(buildTip('permission',
            '<strong>Your first approval.</strong> Mysti is asking because you’re on <strong>' + escapeHtml(pm.label) + '</strong>.' +
            (canRemember ? ' “Yes, and don’t ask again” skips this kind of action for the rest of the session.' : '') +
            ' Change mode from the pill below.'));
        }
   ```
2. `showMentionMenu`, after the menu is un-hidden: `if (!mentionMenu.querySelector('.mysti-tip') && claimTip('mention')) { mentionMenu.insertBefore(buildTip('mention', '<strong>Pick an agent</strong> to send it just this message — your chat stays where it is. <strong>Pick a file</strong> to attach it.'), mentionMenu.firstChild); }` and `hideMentionMenu` removes `mentionMenu.querySelector('.mysti-tip')`.
3. Main `case 'responseComplete'`, after `renderMessageFooter(...)`: `if (finalizedEl.querySelector('.edit-report-card') && state.checkpointsAvailable !== false && claimTip('rewind')) { finalizedEl.insertAdjacentElement('afterend', buildTip('rewind', '<strong>Changed your mind?</strong> The ↺ on your message rewinds this turn’s file changes, or forks the chat from there. Mysti keeps its own snapshots, so your git history is untouched.')); }`
4. `updateStrategyIndicatorVisibility(provider)`, in the brainstorm branch: `maybeShowBrainstormTip();`
   ```js
      function maybeShowBrainstormTip() {
        if (!messagesEl || !claimTip('brainstorm')) { return; }
        var names = (state.brainstormAgents || []).map(function(id) { var e = getManifestEntry(id); return e ? e.displayName : id; });
        var current = state.brainstormStrategy || 'quick';
        var tip = buildTip('brainstorm',
          '<strong>Your first Brainstorm.</strong> Every message runs both agents' + (names.length === 2 ? ' — ' + escapeHtml(names[0]) + ' and ' + escapeHtml(names[1]) : '') +
          ' — so it costs more than one. Pick how they work together:',
          { label: 'Change agents', onClick: function() { settingsBtn.click(); } });
        var list = document.createElement('fieldset');
        list.className = 'bs-strategies';
        list.innerHTML = '<legend class="sr-only">Brainstorm strategy</legend>' + Object.keys(strategyDescriptions).map(function(k) {
          return '<label class="bs-strategy"><input type="radio" name="bs-strategy" value="' + k + '"' + (k === current ? ' checked' : '') + ' />' +
            '<span><strong>' + escapeHtml(STRATEGY_LABELS[k] || k) + '</strong> ' + escapeHtml(strategyDescriptions[k]) + '</span></label>';
        }).join('');
        list.querySelectorAll('input').forEach(function(r) {
          r.addEventListener('change', function() {
            state.brainstormStrategy = r.value;
            if (brainstormStrategySelect) { brainstormStrategySelect.value = r.value; }
            if (brainstormStrategyHint) { brainstormStrategyHint.textContent = strategyDescriptions[r.value] || ''; }
            updateStrategyIndicator();
            postMessageWithPanelId({ type: 'updateSettings', payload: { 'brainstorm.strategy': r.value } });
          });
        });
        tip.querySelector('.mysti-tip-body').insertBefore(list, tip.querySelector('.mysti-tip-actions'));
        messagesEl.appendChild(tip);
      }
   ```
   with `var STRATEGY_LABELS = { quick: 'Quick', debate: 'Debate', 'red-team': 'Red team', perspectives: 'Perspectives', delphi: 'Delphi' };` beside `strategyDescriptions`.
5. `handleCompactionStatus` `'complete'`, after `renderCompactionDivider(event)`: `if (claimTip('compaction')) { messagesEl.appendChild(buildTip('compaction', '<strong>This chat was compacted.</strong> Older turns were summarized so the agent has room to keep going. Your files didn’t change. Starting on something unrelated? A new chat is faster and costs less.', { label: 'New chat', onClick: function() { var b = document.getElementById('new-conversation-btn'); if (b) { b.click(); } } })); }`

- [ ] **Step 1: Failing tests** (append):

```ts
describe('once-only tips', () => {
  const on = (seen: string[] = []) => ({ onboarding: { tips: { enabled: true, seen }, gettingStarted: null } });
  const perm = (id: string) => ({ type: 'permissionRequest', payload: { id, actionType: 'bash-command', title: 'Run', description: 'npm test', details: { command: 'npm test' }, expiresAt: 0 } });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the first permission card gets a tip, marked seen on show, and never a second', async () => {
    const pg = await panel(on());
    await send(pg, perm('p1'));
    expect(await pg.$$eval('.mysti-tip[data-tip="permission"]', (e) => e.length)).toBe(1);
    expect((await posted(pg)).filter((m) => m.type === 'tipSeen')).toEqual([expect.objectContaining({ payload: { id: 'permission' } })]);
    await send(pg, perm('p2'));
    expect(await pg.$$eval('.mysti-tip', (e) => e.length)).toBe(1);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a tip already seen, or tips off, shows nothing', async () => {
    const seen = await panel(on(['permission']));
    await send(seen, perm('p1'));
    expect(await seen.$('.mysti-tip')).toBeNull();
    const off = await panel({ onboarding: { tips: { enabled: false, seen: [] }, gettingStarted: null } });
    await send(off, perm('p1'));
    expect(await off.$('.mysti-tip')).toBeNull();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('only one tip per session', async () => {
    const pg = await panel(on());
    await send(pg, perm('p1'));
    await send(pg, { type: 'compactionStatus', payload: { status: 'complete', beforeTokens: 1000, afterTokens: 100 } });
    expect(await pg.$('.mysti-tip[data-tip="compaction"]')).toBeNull();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('Turn off tips removes it and tells the host', async () => {
    const pg = await panel(on());
    await send(pg, { type: 'compactionStatus', payload: { status: 'complete', beforeTokens: 1000, afterTokens: 100 } });
    await pg.click('.mysti-tip .mysti-tip-off');
    expect(await pg.$('.mysti-tip')).toBeNull();
    expect((await posted(pg)).some((m) => m.type === 'tipsOff')).toBe(true);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('the mention menu carries its tip and drops it on close', async () => {
    const pg = await panel(on());
    await pg.fill('#message-input', '@');
    await pg.type('#message-input', 'c');
    expect(await pg.$('#mention-menu .mysti-tip')).not.toBeNull();
    await pg.keyboard.press('Escape');
    expect(await pg.$('#mention-menu .mysti-tip')).toBeNull();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('switching to Brainstorm offers the strategy inline', async () => {
    const pg = await panel(on());
    await send(pg, { type: 'agentChanged', payload: { agent: 'brainstorm' } });
    await pg.check('.bs-strategies input[value="debate"]');
    const upd = (await posted(pg)).filter((m) => m.type === 'updateSettings').pop();
    expect(upd!.payload).toEqual({ 'brainstorm.strategy': 'debate' });
  });
});
```

(Payload shapes for `permissionRequest` and the mention keystrokes must match what `handlePermissionRequest` and the input listener read — check `case 'permissionRequest'` and the `@` detection when writing the test; adjust field names, not assertions.)

- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS** (`npx vitest run tests/webview/`)
- [ ] **Step 5: Commit** — `git commit -am "feat(onboarding): once-only hints for approvals, mentions, rewind, brainstorm, compaction"`

---

### Task 9: `/help` card, composer placeholder, plain strategy copy

**Files:**
- Modify: `media/chat/chat.js` — `HELP_SECTIONS`, `renderHelpCard`, `case 'showHelp'`; `COMPOSER_PLACEHOLDER` used by `syncComposerAffordance` and the enhance-timeout reset; `strategyDescriptions` text.
- Modify: `media/chat/index.html` — `#message-input` placeholder; `#brainstorm-strategy-hint` text.
- Modify: `media/chat/chat.css` — `.help-card`.
- Test: append to `tests/webview/onboardingBrowser.test.ts`.

```js
      var COMPOSER_PLACEHOLDER = 'Ask anything — @ to mention an agent or file, / for commands';
      var HELP_SECTIONS = [
        { name: 'Get work done', rows: [
          ['Enter', 'Send. Shift+Enter starts a new line.'],
          ['@file.ts', 'Attach a file to this message.'],
          ['Mode pill', 'Plan, Ask, Auto or Full: how much it may do without asking.'],
          ['⌘⇧N / Ctrl+Shift+N', 'Open another chat in its own tab.']
        ] },
        { name: 'Work with other agents', rows: [
          ['@codex', 'Send just this message to another agent.'],
          ['Agent pill', 'Switch the agent for this whole chat.'],
          ['/brainstorm', 'Two agents work on one answer. Uses more tokens.']
        ] },
        { name: 'Undo and long chats', rows: [
          ['↺ on a message', 'Rewind that turn’s file changes, or fork the chat from there.'],
          ['/compact', 'Summarize older turns to free up room.'],
          ['Context ring', 'How full this chat is. It compacts itself at your threshold (75% by default).']
        ] },
        { name: 'Commands', rows: [
          ['/', 'Every command — Mysti’s and your agent’s own.'],
          ['/clear', 'Start this chat over.'],
          ['/mode auto', 'Change mode by typing: plan, ask, auto or full.']
        ] }
      ];
      var HELP_ALIASES = { undo: 'rewind', revert: 'rewind', cost: 'tokens', money: 'tokens', safe: 'mode', safety: 'mode' };

      function renderHelpCard() {
        var card = document.createElement('section');
        card.className = 'help-card';
        card.setAttribute('aria-label', 'Mysti help');
        var uid = 'help-search-' + Date.now();
        card.innerHTML = '<div class="help-head"><img src="' + LOGO_URI + '" alt="" class="help-logo" /><span class="help-title">Mysti help</span></div>' +
          '<label for="' + uid + '" class="sr-only">Search help</label>' +
          '<input id="' + uid + '" type="search" class="help-search" placeholder="Search help — try “undo” or “cost”" autocomplete="off" />' +
          '<div class="help-sections"></div><p class="help-empty hidden">Nothing matches. The tour and the docs cover more.</p>' +
          '<div class="help-foot"><button type="button" class="help-tour">Take the tour</button>' +
          '<a href="https://github.com/DeepMyst/Mysti#readme" target="_blank" rel="noopener">Read the docs</a></div>';
        var sections = card.querySelector('.help-sections');
        function draw(q) {
          var needle = HELP_ALIASES[q] || q;
          var html = '';
          HELP_SECTIONS.forEach(function(s) {
            var rows = s.rows.filter(function(r) { return !needle || (r[0] + ' ' + r[1]).toLowerCase().indexOf(needle) !== -1; });
            if (!rows.length) { return; }
            html += '<div class="help-section"><h4>' + escapeHtml(s.name) + '</h4><dl>' + rows.map(function(r) {
              return '<div class="help-row"><dt><code>' + escapeHtml(r[0]) + '</code></dt><dd>' + escapeHtml(r[1]) + '</dd></div>';
            }).join('') + '</dl></div>';
          });
          sections.innerHTML = html;
          card.querySelector('.help-empty').classList.toggle('hidden', !!html);
        }
        draw('');
        card.querySelector('.help-search').addEventListener('input', function(e) { draw(e.target.value.trim().toLowerCase()); });
        card.querySelector('.help-tour').addEventListener('click', function() { postMessageWithPanelId({ type: 'openWalkthrough' }); });
        messagesEl.appendChild(card);
        scrollToBottom();
      }
```

Strategy copy (`strategyDescriptions` and `STRATEGY_LABELS` from Task 8):

```js
      var strategyDescriptions = {
        'quick': 'Both answer, then one merged reply. Fastest.',
        'debate': 'They critique each other’s answers before merging.',
        'red-team': 'One proposes, the other attacks it, then it’s defended.',
        'perspectives': 'One looks for risks, the other for opportunities.',
        'delphi': 'A facilitator runs rounds until they agree.'
      };
```

`#brainstorm-strategy-hint` static text → `Both answer, then one merged reply. Fastest.`

- [ ] **Step 1: Failing tests** (append):

```ts
describe('/help card and composer copy', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('showHelp renders a searchable card with aliases', async () => {
    const pg = await panel();
    await send(pg, { type: 'showHelp' });
    expect(await pg.$$eval('.help-card .help-row', (r) => r.length)).toBe(13);
    await pg.fill('.help-card .help-search', 'undo');
    expect(await pg.$$eval('.help-card .help-row dt', (r) => r.map((x) => x.textContent))).toEqual(['↺ on a message']);
    await pg.fill('.help-card .help-search', 'zzz');
    expect(await pg.isVisible('.help-card .help-empty')).toBe(true);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('the composer teaches @ and /', async () => {
    const pg = await panel();
    expect(await pg.getAttribute('#message-input', 'placeholder')).toBe('Ask anything — @ to mention an agent or file, / for commands');
  });
});
```

- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS** (`npx vitest run tests/webview/`) — fix any existing test that pinned "Ask Mysti…" by updating its expected string.
- [ ] **Step 5: Commit** — `git commit -am "feat(onboarding): /help card, composer placeholder, plain brainstorm copy"`

---

### Task 10: Walkthrough rewrite + SVG media

**Files:**
- Modify: `package.json` — `contributes.walkthroughs[0]`.
- Create: `media/walkthrough/open.svg`, `connect.svg`, `mode.svg`, `mention.svg`, `brainstorm.svg`, `rewind.svg` — 480×300 viewBox, colours only from `var(--vscode-foreground)`, `var(--vscode-descriptionForeground)`, `var(--vscode-textLink-foreground)`, `var(--vscode-editor-background)`, `var(--vscode-widget-border)`, text in `font-family: var(--vscode-font-family)`.
- Test: `tests/utils/walkthroughSteps.test.ts`.

Steps (ids, titles, descriptions, buttons, completion):

| id | title | button | completionEvents |
|---|---|---|---|
| `mysti.walkthrough.openChat` | Open the Mysti panel | `[Open Mysti](command:mysti.openChat)` | `onCommand:mysti.openChat`, `onView:mysti.chatView` |
| `mysti.walkthrough.connect` | Connect an agent | `[Connect an agent](command:mysti.getStarted)` | `onContext:mysti.agentReady` |
| `mysti.walkthrough.mode` | Choose how much it may do | `[Choose a mode](command:mysti.getStarted?%5B%22mode%22%5D)` | `onSettingChanged:mysti.accessLevel`, `onSettingChanged:mysti.defaultMode` |
| `mysti.walkthrough.mention` | Talk to a second agent | `[Try it in chat](command:mysti.openChat)` | (none — button click) |
| `mysti.walkthrough.brainstorm` | Brainstorm with two agents | `[Open Mysti](command:mysti.openChat)` | (none) |
| `mysti.walkthrough.rewind` | Rewind a turn | `[Open Mysti](command:mysti.openChat)` | (none) |

Descriptions: the copy on the Walkthrough board of the design canvas (Plan: "Plan only reads. Ask checks with you before each edit. Auto edits inside the workspace. Full does everything. Every turn is checkpointed either way."; Brainstorm adds "Pick **Brainstorm** from the agent menu, or type ``/brainstorm``.").

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ext = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
const steps: Array<{ id: string; description: string; completionEvents?: string[] }> = pkg.contributes.walkthroughs[0].steps;
const contributed = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));

describe('the Get Started walkthrough', () => {
  it('every command link names a command Mysti contributes and registers', () => {
    for (const s of steps) {
      for (const [, id] of s.description.matchAll(/\(command:([\w.]+)/g)) {
        expect(contributed.has(id), `${s.id} links to ${id}`).toBe(true);
        expect(ext, `${id} is never registered`).toContain(`registerCommand('${id}'`);
      }
    }
  });
  it('no two steps complete on the same event (the old step 3 ticked itself when step 1 did)', () => {
    const seen = new Map<string, string>();
    for (const s of steps) {
      for (const e of s.completionEvents ?? []) {
        expect(seen.get(e), `${s.id} and ${seen.get(e)} both complete on ${e}`).toBeUndefined();
        seen.set(e, s.id);
      }
    }
  });
  it('connecting completes on the readiness context key the host sets', () => {
    const connect = steps.find((s) => s.id === 'mysti.walkthrough.connect')!;
    expect(connect.completionEvents).toEqual(['onContext:mysti.agentReady']);
  });
  it('is no longer a marketing funnel', () => {
    expect(steps.map((s) => s.id)).not.toContain('mysti.walkthrough.star');
  });
});
```

- [ ] **Step 2: FAIL** → **Step 3: implement package.json + six SVGs** → **Step 4: PASS** (`npx vitest run tests/utils/walkthroughSteps.test.ts tests/utils/manifestPackaging.test.ts`)
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): six-step walkthrough with theme-aware media"`

---

### Task 11: Full gate and docs

**Files:**
- Modify: `CLAUDE.md` — VSCode Integration Points: add `mysti.getStarted` to Commands; Major subsystems: one bullet "**Onboarding** (`plans/32`) — …".
- Modify: `plans/32-onboarding.md` — Status: IMPLEMENTED with the commit range.

- [ ] **Step 1:** `npm run lint` — expect 0 errors (provider literals, core manifest, eslint).
- [ ] **Step 2:** `npm run typecheck` — expect 0.
- [ ] **Step 3:** `npx vitest run` — expect all green; count ≥ baseline 13148 + new.
- [ ] **Step 4:** `npm run compile` — expect webpack success.
- [ ] **Step 5:** Commit docs — `git commit -am "docs(plan-32): onboarding in CLAUDE.md; plan status"`
- [ ] **Step 6:** Whole-branch review (superpowers:requesting-code-review) on `dae9bd3..HEAD`; fix confirmed findings; re-run Steps 1–4.
