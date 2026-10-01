# Manage Plugins — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor tab where the user lists, installs, toggles, updates and removes plugins for Claude Code, Copilot, OpenClaw and Hermes, using only each backend's own CLI.

**Architecture:**
- A total `Record<ProviderType, PluginAdapter | { note } | null>` describes each backend. An operation exists only if its method exists.
- `PluginsPanelManager` owns one webview tab. It validates every webview message against the last listing, runs the install gate as a **native** modal, and serializes mutations per backend.
- After any successful change it calls `provider.markPluginsChanged()`. That bumps a counter the existing persistent-process respawn check compares, so open chats pick up the change on their next message.

**Tech stack:** TypeScript (strict, ES2022), `child_process.execFile` (no shell), VS Code webview (CSP + nonce), Vitest plus the Chromium browser suite (Playwright).

**Spec:** `plans/29-manage-plugins.md` (approved 2026-10-01) and the design canvas <https://claude.ai/artifact/MWZ1Fv29Zq5fYmWZra1b1t>.

## Global Constraints

- **Every** CLI call is `execFile(cliPath, argv)` with no shell. `cliPath` comes from the provider's `getCliPath()`.
- Timeouts: list/search/details 30 000 ms; install/update/marketplace add/refresh 300 000 ms. On timeout, SIGKILL.
- **Exit codes are not trusted for Claude.** A failed install exits 0, and an already-applied disable exits 1. A Claude result is the `--json` line's `outcome`: it failed only when `outcome === 'failed'` and `alreadyInGoalState` is not `true`.
- Never pass `-y`, `--yes` or `--force`, except `--accept-command <sha>` after the modal, and OpenClaw `uninstall --force` (it only skips the TTY "are you sure").
- The gate confirms when contents are `'unknown'` or include hooks, MCP servers or LSP servers. Copilot, OpenClaw and Hermes are always `'unknown'` or code.
- `project`/`local` scopes require `vscode.workspace.isTrusted === true`.
- No model-reachable path: `/plugins` and the hub nav only **open** the tab.
- All webview text from a CLI or marketplace is rendered with `textContent`, never `innerHTML`.
- Every new source file carries the Apache-2.0 header used across `src/`.

## Review Focus

1. **An id or scope from the webview that isn't in the last listing** (a crafted `--flag` id, `scope: 'managed'`) must be refused before any spawn. Tested in Task 4.
2. **Claude reporting failure with exit code 0** must show as an error, not success, and must not bump the generation. Tested in Tasks 2 and 4.
3. **Two clicks on Install in a row** for the same backend must run in sequence, not in parallel. Tested in Task 4.
4. **A marketplace source that starts with `-`** must be refused, not passed as a flag. Tested in Task 4.
5. **A plugin description containing HTML** must render as text. Tested in Task 5's browser test.

---

### Task 1: Plugin generation in the persistent-process respawn check

**Files:**
- Modify: `src/providers/base/BaseCliProvider.ts` (`persistentSettings` type ~L151; recording at ~L944 and ~L1210; `_persistentSettingsMatch` ~L1173)
- Modify: `src/providers/base/IProvider.ts` (`ICliProvider`: optional `markPluginsChanged?(): void`)
- Test: `tests/providers/pluginGeneration.test.ts`

**Interfaces:**
- Produces: `BaseCliProvider.markPluginsChanged(): void` and `persistentSettings.pluginGeneration: number`.

- [ ] Write a failing test using `TestableClaudeProvider` from `tests/helpers/providerFactory.ts`:
  - with `session.persistentSettings` set from current settings, `_persistentSettingsMatch` is `true`;
  - after `markPluginsChanged()` it is `false`.
- [ ] Run `npx vitest run tests/providers/pluginGeneration.test.ts`. It should fail.
- [ ] Implement:
  - a private `_pluginGeneration = 0` field;
  - `markPluginsChanged() { this._pluginGeneration++; }`;
  - `pluginGeneration: this._pluginGeneration` added to **both** snapshot literals;
  - `&& ps.pluginGeneration === this._pluginGeneration` added to the match.
- [ ] Run the test, then the Hermes and Kimi suites (`npx vitest run tests/providers/hermes tests/providers/kimi`). All should pass.
- [ ] Commit `feat(plugins): plugin changes respawn persistent CLI processes on the next message`.

### Task 2: Adapter contract, runner, and the Claude Code adapter

**Files:**
- Create: `src/services/plugins/PluginAdapters.ts`
- Create: `tests/fixtures/plugins/claude-list.json` (real `claude plugin list --json --available` output, trimmed to 3 installed and 4 available)
- Create: `tests/services/plugins/claudeAdapter.test.ts`

**Interfaces (produced, used by Tasks 3 and 4):**

```ts
export type PluginScope = 'user' | 'project' | 'local';
export interface InstalledPlugin { id: string; name: string; marketplace?: string; version?: string; scope: PluginScope | 'bundled'; enabled?: boolean; description?: string; error?: string }
export interface CatalogPlugin { id: string; name: string; marketplace?: string; description?: string; installCount?: number; source?: unknown }
export interface PluginListing { installed: InstalledPlugin[]; available?: CatalogPlugin[]; warning?: string }
export interface Approval { acceptCommandSha?: string }
export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Run = (args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;
export type CodeParts = string[] | 'unknown';           // [] = runs no code
export class PluginCliError extends Error { constructor(message: string, readonly acceptCommand?: { command: string; sha: string }) }
export interface PluginAdapter {
  scopes: PluginScope[];
  list(run: Run): Promise<PluginListing>;
  search?(run: Run, query: string): Promise<CatalogPlugin[]>;
  inspect(run: Run, entry: CatalogPlugin): Promise<CodeParts>;
  install(run: Run, id: string, scope: PluginScope, approval?: Approval): Promise<void>;
  uninstall?(run: Run, p: InstalledPlugin): Promise<void>;
  setEnabled?(run: Run, p: InstalledPlugin, on: boolean): Promise<void>;
  update?(run: Run, p: InstalledPlugin): Promise<void>;
  details?(run: Run, p: InstalledPlugin): Promise<string>;
  marketplaces?: {
    list(run: Run): Promise<{ name: string; source: string; builtin?: boolean }[]>;
    add(run: Run, source: string): Promise<void>;
    remove(run: Run, name: string): Promise<void>;
    refresh(run: Run, name: string): Promise<void>;
  };
}
export type PluginBackend = PluginAdapter | { note: string } | null;
export const PLUGIN_ADAPTERS: Record<ProviderType, PluginBackend>;
export function runCli(cliPath: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<RunResult>;
export const LIST_TIMEOUT_MS = 30_000; export const MUTATE_TIMEOUT_MS = 300_000;
```

- [ ] Write failing tests:
  - `list()` maps the fixture: id `superpowers@claude-plugins-official` becomes name `superpowers`, marketplace `claude-plugins-official`; installed `enabled`/`scope`; available `pluginId` becomes `id`.
  - `install` builds argv `['plugin','install',id,'-s','project','--json']`, plus `['--accept-command',sha]` only when approved.
  - `install` throws `PluginCliError` when the run exits 0 with `{"outcome":"failed","message":"X"}` (message `X`).
  - `setEnabled(false)` resolves when exit 1 carries `alreadyInGoalState: true`.
  - `inspect` on a temp marketplace dir returns:
    - `['Hooks']` for `./plugins/a` containing `hooks/hooks.json`;
    - `['MCP servers']` for `.mcp.json`;
    - `['LSP servers']` for a marketplace entry with inline `lspServers`;
    - `[]` for commands-only;
    - `'unknown'` for an object source.
  - Non-JSON stdout from `list` throws `PluginCliError("Couldn't read Claude Code's plugin list")`.
- [ ] Run them. They should fail.
- [ ] Implement:
  - `runCli` via `execFile(cliPath, args, { cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 64 MiB, windowsHide: true, env: getEnrichedEnv() })`;
  - a `claudeResult(r)` helper that reads the first `{`-prefixed stdout line;
  - the Claude adapter (marketplace dir from `plugin marketplace list --json`, `installLocation`);
  - `inspect` reading `<installLocation>/.claude-plugin/marketplace.json`, the entry's inline keys, and (for string sources) the plugin dir's `.claude-plugin/plugin.json` keys plus the default files.
- [ ] Run the tests. They should pass.
- [ ] Commit `feat(plugins): adapter contract + Claude Code adapter`.

### Task 3: Copilot, OpenClaw, Hermes adapters and the notes

**Files:**
- Modify: `src/services/plugins/PluginAdapters.ts`
- Create: `tests/fixtures/plugins/{copilot-browse.json,openclaw-list.json,openclaw-search.json}` (real output, trimmed); Hermes uses an inline fixture taken from its documented JSON
- Create: `tests/services/plugins/otherAdapters.test.ts`

- [ ] Write failing tests:
  - **Copilot:**
    - `list` combines `plugin list --json` with `marketplace list --json` and `marketplace browse <m> --json` per marketplace, giving available ids `name@marketplace`;
    - install argv `['plugin','install','workiq@copilot-plugins']`;
    - exit 1 throws with the stderr text;
    - `inspect` is `'unknown'`.
  - **OpenClaw:**
    - bundled plugins get scope `'bundled'` and no uninstall;
    - `search` maps `results[].package` (`name`, `summary`, `latestVersion`), with install spec `clawhub:<name>`;
    - uninstall argv ends with `--force`;
    - error text drops `│`/`◇` box-drawing lines.
  - **Hermes:** `list` maps `status === 'enabled'`; `inspect` maps capabilities to `Hooks`, `Tools`, `Middleware`, defaulting to `['Python code']`; install argv includes `--enable`.
  - **Table:** `PLUGIN_ADAPTERS` has a key for every id in `providerManifest.test.ts`'s list. Codex, Gemini, Qwen, Cline, OpenCode, Cursor and Kimi are `{ note }`. Continue, Ollama, LocalAI and OpenRouter are `null`.
- [ ] Run, implement, run, then commit `feat(plugins): Copilot, OpenClaw and Hermes adapters`.

### Task 4: PluginsPanelManager — validation, gate, serialization

**Files:**
- Create: `src/managers/PluginsPanelManager.ts`
- Create: `tests/managers/pluginsPanelManager.test.ts`

**Interfaces:**
- Consumes: Task 2/3 exports, and `ProviderManager.getProviderInstance(id)` (`getCliPath()`, `getCachedCliVersion?()`, `markPluginsChanged?()`).
- Produces:
  - `new PluginsPanelManager(extensionUri, providers: { getProviderInstance(id: string): ICliProvider | undefined; getAllProviderIds(): ProviderType[] }, deps?: { run?: (cliPath: string, args: string[], opts?) => Promise<RunResult>; adapters?: Record<string, PluginBackend> })`
  - `open(): void`, `handleMessage(msg): Promise<void>` (public for tests), and `onState: (s: PluginsViewState) => void` (posts to the webview; tests read it).

**Webview → host messages:**
- `ready`, `refresh`
- `select {backend}`, `search {query}`
- `install {id, scope}`, `uninstall {id}`, `setEnabled {id, on}`, `update {id}`, `details {id}`
- `addMarketplace {source}`, `removeMarketplace {name}`, `refreshMarketplace {name}`

**Host → webview:** `{ type: 'state', state: PluginsViewState }`, where:

```ts
{ backends: { id; name; status: 'ok'|'note'|'none'|'missing'; note?: string; version?: string }[];
  selected: string; scopes: PluginScope[]; can: { toggle; update; uninstall; details; marketplaces; search };
  trusted: boolean; listing?: PluginListing; searchResults?: CatalogPlugin[]; markets?: {…}[];
  busy: Record<string,string>; rowErrors: Record<string,string>; banner?: string; error?: string; details?: { id: string; text: string } }
```

- [ ] Write failing tests (fake `run` recording argv; stub `window.showWarningMessage`; set `(workspace as any).isTrusted`):
  1. An `install` whose id is not in the last listing → no spawn and a `rowErrors` entry. A crafted id `--evil` → no spawn.
  2. `scope: 'project'` while untrusted → no spawn.
  3. Contents `['Hooks']` and the modal declined → no install spawn. Accepted → install spawn, then a re-list, then `markPluginsChanged` called once.
  4. Commands only → no modal, installs.
  5. Claude `outcome: failed` at exit 0 → `rowErrors[id]` is the message, and `markPluginsChanged` is **not** called.
  6. Two `install` messages without awaiting the first → the second spawn starts after the first resolves (resolution order recorded).
  7. `addMarketplace` with source `-x` → refused. A valid source → modal, then `marketplace add` argv.
  8. A `PluginCliError` with `acceptCommand` → a second modal showing the command. Accepted → rerun with `--accept-command <sha>`.
- [ ] Run, implement (`_queue: Map<string, Promise<unknown>>` per backend, `_lastListing` per backend, native modals with `{ modal: true, detail }`), run, then commit `feat(plugins): panel manager with fail-closed install gate`.

### Task 5: The webview

**Files:**
- Create: `src/webview/pluginsContent.ts` (copy of the `connectionsContent.ts` loader for `media/plugins`)
- Create: `media/plugins/index.html`, `media/plugins/plugins.js`, `media/plugins/plugins.css`
- Create: `tests/webview/pluginsBrowser.test.ts`

**Layout** follows the canvas, without the hub nav:
- header: title, backend `<select>` (disabled options carry the reason), refresh;
- note line, warning line, banner;
- tabs Plugins / Marketplaces;
- search; Installed (switch, ⋯ menu with Details/Update/Uninstall per `can`);
- Available (Install, an inline scope chooser when `scopes.length > 1`, project/local disabled when `!trusted`);
- a 100-row cap with "N more — search to narrow the list";
- `busy` text and `rowErrors` inline per row.

The page uses VS Code theme variables (`--vscode-*`) so light, dark and high-contrast all work.

- [ ] Write a failing browser test (`CHROMIUM_UNAVAILABLE` skip; inline the CSS and JS; stub `acquireVsCodeApi`; dispatch a `state` message):
  - rows render;
  - typing in search filters both lists;
  - 150 available entries render 100 rows plus the "50 more" line;
  - a description `<img src=x onerror=…>` renders as text;
  - clicking Install with three scopes shows three scope buttons, two of them disabled when `trusted: false`;
  - the switch posts `setEnabled`.
- [ ] Run, implement, run, then commit `feat(plugins): Manage Plugins webview`.

### Task 6: Entry points, docs, full gate

**Files:**
- Modify:
  - `src/extension.ts` (construct, register `mysti.managePlugins`);
  - `package.json` (`contributes.commands`: `mysti.managePlugins`, "Manage Plugins", category Mysti, icon `$(extensions)`);
  - `src/managers/SlashCommandManager.ts` (`'plugins': 'cmd:plugins'`, an execute case, a menu entry);
  - `media/chat/index.html` + `media/chat/chat.js` (a hub nav "Plugins" button, `data-hub-plugins`, posting `openPlugins`);
  - `src/chat/settingsHub.ts` (`openPlugins` in `HUB_INBOUND_TYPES` and `HUB_UNBOUND_TYPES`);
  - `src/providers/ChatViewProvider.ts` (`case 'openPlugins'` runs `mysti.managePlugins`);
  - `CLAUDE.md` (Integration Points), `plans/29-manage-plugins.md` (status).
- Test: extend `tests/chat/settingsHub.test.ts` (the type is unbound), and the slash command test file that covers `cmd:update-clis`.

- [ ] Write failing tests:
  - `executeCommand('cmd:plugins')` calls `mysti.managePlugins`;
  - `HUB_UNBOUND_TYPES.has('openPlugins')`.
- [ ] Implement and run.
- [ ] Run the full gate: `npm run typecheck && npm test && npm run lint`. All must be green, with no new lint errors.
- [ ] Commit `feat(plugins): /plugins, command palette and Mysti tab entry points`.
